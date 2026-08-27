import sys
from app.db import SessionLocal
from app.graph.analysis import detect_orphans

with SessionLocal() as session:
    findings = detect_orphans(14, session)
    print("Orphans detected:", len(findings))
    for f in findings[:5]:
        print(f.file, f.message)
