# Stage 1: Build environment
FROM python:3.12-alpine AS builder

WORKDIR /app

# Build dependencies for Python packages such as psycopg
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libffi-dev \
    postgresql-dev \
    python3-dev

# Build Python wheels
COPY requirements.txt .

RUN pip wheel \
    --no-cache-dir \
    --wheel-dir /usr/src/app/wheels \
    -r requirements.txt


# Stage 2: Runtime environment
FROM python:3.12-alpine

WORKDIR /app

# Runtime dependencies
RUN apk add --no-cache \
    libpq \
    git \
    curl

# Install Gitleaks
RUN curl -sSfL \
    https://github.com/gitleaks/gitleaks/releases/download/v8.18.2/gitleaks_8.18.2_linux_x64.tar.gz \
    | tar -xz -C /usr/local/bin gitleaks

# Install OSV-Scanner
RUN curl -sSfL \
    https://github.com/google/osv-scanner/releases/download/v2.0.2/osv-scanner_linux_amd64 \
    -o /usr/local/bin/osv-scanner \
    && chmod +x /usr/local/bin/osv-scanner

# Copy Python wheels
COPY --from=builder /usr/src/app/wheels /wheels

# Install Python dependencies
RUN pip install --no-cache-dir /wheels/*


# Copy application
COPY . .


# Verify application and security tools
RUN DATABASE_URL=postgresql://dummy \
    python -c "import app.main" \
    && git --version \
    && gitleaks version \
    && osv-scanner --version \
    && python -c "import semgrep; print('semgrep', semgrep.__version__)" \
    && python -c "import lizard; print('lizard', lizard.version)"


EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
