from urllib.parse import urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_JWT_SECRET = "dev-secret-change-me"
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    jwt_secret: str = DEFAULT_JWT_SECRET
    openai_api_key: str = ""
    openai_model: str = "gpt-5"
    github_client_id: str = ""
    github_client_secret: str = ""
    frontend_url: str = "http://localhost:3000"
    # Used to build the OAuth redirect_uri explicitly. request.url_for() can't be
    # trusted for this behind a TLS-terminating proxy (e.g. Railway): uvicorn sees
    # the plain-HTTP connection forwarded by the proxy and reports scheme="http",
    # producing a redirect_uri that never matches the https:// callback URL
    # registered with GitHub.
    backend_url: str = "http://localhost:8000"
    # Set when the frontend and backend live on different hosts. The cookie then
    # needs SameSite=None; Secure, which browsers only accept over https.
    cookie_cross_site: bool = False


settings = Settings()


def check_production_secrets(config: Settings = settings) -> None:
    """Refuse to start with the shipped JWT secret anywhere but localhost.

    A default secret means anyone can mint a session for an arbitrary user_id.
    Local development keeps the default and stays frictionless.
    """
    if config.jwt_secret != DEFAULT_JWT_SECRET:
        return
    host = urlsplit(config.frontend_url).hostname or ""
    if host in _LOCAL_HOSTS:
        return
    raise RuntimeError(
        "JWT_SECRET is still the built-in development default, but FRONTEND_URL "
        f"({config.frontend_url}) is not localhost. Sessions would be forgeable by "
        "anyone. Set JWT_SECRET to a random value, e.g. "
        "`python -c 'import secrets; print(secrets.token_urlsafe(32))'`."
    )
