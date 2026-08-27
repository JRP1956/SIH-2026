from urllib.parse import urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_JWT_SECRET = "dev-secret-change-me"
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    jwt_secret: str = DEFAULT_JWT_SECRET
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    github_client_id: str = ""
    github_client_secret: str = ""
    github_app_id: str = ""
    github_app_private_key: str = ""
    frontend_url: str = "http://localhost:3000"
    # Set when the frontend and backend live on different hosts. The cookie then
    # needs SameSite=None; Secure, which browsers only accept over https.
    cookie_cross_site: bool = False
    
    redis_url: str = "redis://redis:6379/0"


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
