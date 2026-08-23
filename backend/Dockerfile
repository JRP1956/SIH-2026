# Stage 1: Build environment
FROM python:3.12-alpine AS builder

WORKDIR /app

# Install build dependencies (needed for psycopg, etc)
RUN apk add --no-cache gcc musl-dev libffi-dev postgresql-dev python3-dev

# Install Python dependencies
COPY requirements.txt .
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /usr/src/app/wheels -r requirements.txt

# Stage 2: Final runtime environment
FROM python:3.12-alpine

WORKDIR /app

# Install runtime dependencies and the required security scanners
RUN apk add --no-cache \
    libpq \
    git \
    go \
    curl \
    semgrep

# Install Gitleaks
RUN curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.18.2/gitleaks_8.18.2_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks

# Install OSV-Scanner
RUN go install github.com/google/osv-scanner/cmd/osv-scanner@v1.7.1 && \
    mv /root/go/bin/osv-scanner /usr/local/bin/

# Copy python wheels from builder
COPY --from=builder /usr/src/app/wheels /wheels
RUN pip install --no-cache /wheels/*

# Copy application code
COPY . .

# Smoke test all required tools and python imports (mocking env vars for pydantic)
RUN DATABASE_URL=postgresql://dummy python -c "import app.main" \
    && git --version \
    && gitleaks version \
    && osv-scanner --version \
    && semgrep --version \
    && python -c "import lizard; print('lizard', lizard.version)"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
