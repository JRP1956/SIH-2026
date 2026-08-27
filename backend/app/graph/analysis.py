import json
import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import select
from google import genai
from google.genai import types

from app.graph.models import Contributor, CodeFile, AuthoredEdge, PRComment, PRCache, CandidateRule
from app.scanners.base import RawFinding
from app.graph.pr_fetcher import fetch_active_collaborators
from app.models import Scan
from app.config import settings

log = logging.getLogger(__name__)

RULE_PROMPT = """
You are a senior engineer extracting unwritten team rules from PR code reviews. 
Given these PR comments, identify strictly enforced technical patterns, architectural constraints, 
or repository-specific gotchas. Do not extract generic coding advice or simple bug fixes. 
Be concise.
Reply with JSON: {"rules": ["Rule 1", "Rule 2"]}
"""

def detect_orphans(scan_id: int, session: Session) -> list[RawFinding]:
    """Find files where the top contributor is inactive (no commits in 180 days AND not in active collaborators)."""
    scan = session.get(Scan, scan_id)
    if not scan:
        return []
        
    # Attempt to fetch real collaborators via GitHub App API
    active_github_logins = fetch_active_collaborators(session, scan.repo_key)
    
    # Determine active vs inactive contributors based on local git history
    # Changed to 15 minutes for immediate testing as requested
    active_threshold = datetime.now(timezone.utc) - timedelta(minutes=15)
    contributors = session.execute(
        select(Contributor).where(Contributor.scan_id == scan_id)
    ).scalars().all()
    
    active_contributors = set()
    for c in contributors:
        # Match by email/name vs github login is tricky, but often they align or 
        # we just rely on local history IF the API fetch failed.
        # Since we just have name/email in local git, we will assume if the github fetch
        # returned people, we use the github fetch to heavily filter. But wait, git `name` 
        # might not match github `login`. This is a known limitation. We will use a fuzzy match or
        # just check if the author's git name/email is somehow linked. 
        # For simplicity, if github API returned an empty list (no app installed), fallback to 6 months.
        # If it returned a list, we check if the git name or email prefix matches any login.
        
        is_active = False
        
        if active_github_logins:
            email_prefix = c.email.split("@")[0].lower() if c.email else ""
            name_lower = c.name.lower() if c.name else ""
            for login in active_github_logins:
                login_lower = login.lower()
                if login_lower in name_lower or login_lower in email_prefix:
                    is_active = True
                    break
        else:
            # Fallback to 15 minutes logic
            if c.last_commit_at and c.last_commit_at > active_threshold:
                is_active = True
                
        if is_active:
            active_contributors.add(c.id)
            
    contributor_map = {c.id: c for c in contributors}
    
    files = session.execute(
        select(CodeFile).where(CodeFile.scan_id == scan_id)
    ).scalars().all()
    
    edges = session.execute(
        select(AuthoredEdge).where(AuthoredEdge.scan_id == scan_id)
    ).scalars().all()
    
    edges_by_file = {}
    for e in edges:
        edges_by_file.setdefault(e.file_id, []).append(e)
    
    findings = []
    
    for f in files:
        file_edges = edges_by_file.get(f.id, [])
        if not file_edges:
            continue
            
        primary_edge = max(file_edges, key=lambda e: e.lines_owned)
        primary_contrib = contributor_map[primary_edge.contributor_id]
        
        is_orphan = primary_edge.contributor_id not in active_contributors
        if is_orphan:
            f.is_orphan = True
            
            message = f"File is orphaned: Primary author {primary_contrib.name} hasn't committed recently."
            if active_github_logins:
                message = f"File is orphaned: Primary author {primary_contrib.name} is no longer an active collaborator on GitHub."
                
            findings.append(
                RawFinding(
                    tool="tribal-graph",
                    severity="info",
                    file=f.path,
                    line=0,
                    message=message,
                    category="tribal",
                    extra={
                        "primary_author_name": primary_contrib.name,
                        "primary_author_email": primary_contrib.email,
                        "ownership_percentage": primary_edge.ownership_percentage,
                        "last_commit_at": primary_contrib.last_commit_at.isoformat() if primary_contrib.last_commit_at else None
                    }
                )
            )
            
    session.flush()
    return findings


def extract_rules(session: Session, repo_key: str) -> None:
    """Extract unwritten team rules from recently fetched PR comments using Gemini."""
    if not settings.gemini_api_key:
        return
        
    # Get recent PR comments for this repo
    comments = session.execute(
        select(PRComment)
        .join(PRCache, PRComment.pr_id == PRCache.id)
        .where(PRCache.repo_key == repo_key)
        .order_by(PRComment.id.desc())
        .limit(200)
    ).scalars().all()
    
    if not comments:
        return
        
    comment_texts = [f"{c.author}: {c.body}" for c in comments]
    payload = "\\n".join(comment_texts)
    
    try:
        client = genai.Client(api_key=settings.gemini_api_key)
        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=payload,
            config=types.GenerateContentConfig(
                system_instruction=RULE_PROMPT,
                response_mime_type="application/json",
            ),
        )
        if not response.text:
            return
            
        data = json.loads(response.text)
        rules = data.get("rules", [])
        
        # Check existing rules to avoid duplicates
        existing_rules = set(
            session.execute(
                select(CandidateRule.rule_text).where(CandidateRule.repo_key == repo_key)
            ).scalars().all()
        )
        
        for rule_text in rules:
            if not isinstance(rule_text, str) or len(rule_text) < 10:
                continue
                
            # Sanitization and injection mitigation
            rule_text = rule_text.strip()[:500] # Cap length
            if "ignore all previous instructions" in rule_text.lower():
                continue
                
            if rule_text not in existing_rules:
                session.add(CandidateRule(
                    repo_key=repo_key,
                    rule_text=rule_text,
                    status="pending"
                ))
                existing_rules.add(rule_text)
                
        session.commit()
    except Exception as exc:
        log.warning("Rule extraction failed: %s", exc)
        session.rollback()
