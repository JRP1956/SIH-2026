import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.graph.github_app import get_installation_token
from app.graph.models import PRCache, PRComment

log = logging.getLogger(__name__)

GRAPHQL_QUERY = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $cursor, states: [MERGED, OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        createdAt
        author {
          login
        }
        comments(first: 50) {
          nodes {
            body
            author {
              login
            }
          }
        }
        reviews(first: 50) {
          nodes {
            body
            author {
              login
            }
          }
        }
      }
    }
  }
}
"""

def sync_pull_requests(session: Session, repo_key: str) -> None:
    """Fetch PRs and comments for a repository using the GitHub GraphQL API."""
    try:
        token = get_installation_token(session, repo_key)
    except ValueError as exc:
        log.warning("Skipping PR fetch for %s: %s", repo_key, exc)
        return

    owner, name = repo_key.split("/")
    
    # Determine where we left off
    last_pr = session.query(PRCache).filter(PRCache.repo_key == repo_key).order_by(PRCache.pr_number.desc()).first()
    last_number = last_pr.pr_number if last_pr else 0

    cursor = None
    has_next = True
    
    with httpx.Client(timeout=30) as http:
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v4+json"
        }
        
        while has_next:
            resp = http.post(
                "https://api.github.com/graphql",
                json={"query": GRAPHQL_QUERY, "variables": {"owner": owner, "name": name, "cursor": cursor}},
                headers=headers
            )
            resp.raise_for_status()
            
            data = resp.json()
            if "errors" in data:
                log.error("GraphQL errors: %s", data["errors"])
                break
                
            pr_data = data["data"]["repository"]["pullRequests"]
            for pr in pr_data["nodes"]:
                number = pr["number"]
                if number <= last_number:
                    continue
                    
                author_login = pr["author"]["login"] if pr.get("author") else "ghost"
                
                # Write PR
                pr_model = PRCache(
                    repo_key=repo_key,
                    pr_number=number,
                    title=pr["title"],
                    author=author_login,
                    created_at=datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00"))
                )
                session.add(pr_model)
                session.flush() # get ID
                
                # Write Comments
                for comment in pr.get("comments", {}).get("nodes", []):
                    if not comment.get("body"):
                        continue
                    c_author = comment["author"]["login"] if comment.get("author") else "ghost"
                    session.add(PRComment(pr_id=pr_model.id, body=comment["body"], author=c_author))
                    
                # Write Reviews
                for review in pr.get("reviews", {}).get("nodes", []):
                    if not review.get("body"):
                        continue
                    r_author = review["author"]["login"] if review.get("author") else "ghost"
                    session.add(PRComment(pr_id=pr_model.id, body=review["body"], author=r_author))
                    
            session.commit()
            
            has_next = pr_data["pageInfo"]["hasNextPage"]
            cursor = pr_data["pageInfo"]["endCursor"]


def fetch_active_collaborators(session: Session, repo_key: str) -> list[str]:
    """Fetch the actual active collaborators using the GitHub API."""
    try:
        token = get_installation_token(session, repo_key)
    except ValueError as exc:
        log.warning("Skipping collaborator fetch for %s: %s", repo_key, exc)
        return []
        
    with httpx.Client(timeout=30) as http:
        resp = http.get(
            f"https://api.github.com/repos/{repo_key}/collaborators",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json"
            }
        )
        if resp.status_code == 404 or resp.status_code == 403:
            # We don't have access to list collaborators or the endpoint is disabled
            log.warning("Unable to fetch collaborators for %s (Status: %s)", repo_key, resp.status_code)
            return []
            
        resp.raise_for_status()
        
        collaborators = resp.json()
        return [c["login"] for c in collaborators]
