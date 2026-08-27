import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from sqlalchemy.orm import Session
from app.graph.models import Contributor, CodeFile, AuthoredEdge

def get_contributors(workspace: Path) -> dict[str, tuple[str, str, datetime]]:
    """Parse git log to get unique authors and their latest commit dates."""
    cmd = ["git", "log", "--format=%aN%x00%aE%x00%aI"]
    result = subprocess.run(cmd, cwd=workspace, capture_output=True, text=True, errors="replace")
    if result.returncode != 0:
        return {}
    
    contributors = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            name, email, date_str = line.split("\x00")
            dt = datetime.fromisoformat(date_str)
            # Use email as the primary key for the dictionary
            if email not in contributors or dt > contributors[email][2]:
                contributors[email] = (name, email, dt)
        except ValueError:
            continue
    return contributors

def ingest_blame(workspace: Path, scan_id: int, session: Session) -> None:
    """Run git blame on all tracked files and write the graph to the database."""
    # 1. Fetch contributors
    contrib_data = get_contributors(workspace)
    db_contributors = {}
    for email, (name, _, dt) in contrib_data.items():
        contrib = Contributor(scan_id=scan_id, name=name, email=email, last_commit_at=dt)
        session.add(contrib)
        db_contributors[email] = contrib
    
    session.flush() # get contributor IDs
    
    # 2. Get all tracked files
    result = subprocess.run(
        ["git", "ls-tree", "-r", "HEAD", "--name-only"], 
        cwd=workspace, capture_output=True, text=True, errors="replace"
    )
    if result.returncode != 0:
        return
    
    files = result.stdout.splitlines()
    for file_path in files:
        if not file_path.strip():
            continue
        
        # 3. Blame each file
        blame_cmd = ["git", "blame", "--line-porcelain", "HEAD", "--", file_path]
        blame_result = subprocess.run(
            blame_cmd, cwd=workspace, capture_output=True, text=True, errors="replace"
        )
        if blame_result.returncode != 0:
            continue
            
        lines_by_email = defaultdict(int)
        total_lines = 0
        current_email = None
        
        for line in blame_result.stdout.splitlines():
            if line.startswith("author-mail "):
                # Format is "author-mail <email>"
                email = line[12:].strip("<>")
                current_email = email
            elif line.startswith("\t"):
                # Source line
                if current_email:
                    lines_by_email[current_email] += 1
                    total_lines += 1
                current_email = None
                
        if total_lines == 0:
            continue
            
        # 4. Save CodeFile
        code_file = CodeFile(scan_id=scan_id, path=file_path)
        session.add(code_file)
        session.flush() # get file ID
        
        # 5. Save AuthoredEdges
        for email, lines in lines_by_email.items():
            if email not in db_contributors:
                # Fallback for emails in blame but not in log (should be rare)
                contrib = Contributor(scan_id=scan_id, name=email.split("@")[0], email=email)
                session.add(contrib)
                session.flush()
                db_contributors[email] = contrib
                
            edge = AuthoredEdge(
                scan_id=scan_id,
                file_id=code_file.id,
                contributor_id=db_contributors[email].id,
                lines_owned=lines,
                ownership_percentage=round(lines / total_lines, 4)
            )
            session.add(edge)
