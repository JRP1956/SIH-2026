import * as vscode from "vscode";
import { ApiClient, ApiError } from "../api/client";
import type { User } from "../api/types";
import { getApiUrl } from "../utils/config";

const SECRET_PREFIX = "vibeguard.session.";

export class AuthService implements vscode.Disposable {
  private user: User | null = null;
  private readonly emitter = new vscode.EventEmitter<User | null>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient,
  ) {}

  get currentUser(): User | null {
    return this.user;
  }

  secretKey(): string {
    return SECRET_PREFIX + getApiUrl();
  }

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey());
  }

  async setSession(user: User, token: string): Promise<void> {
    await this.context.secrets.store(this.secretKey(), token);
    this.user = user;
    this.emitter.fire(user);
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(this.secretKey());
    this.user = null;
    this.emitter.fire(null);
  }

  async restore(): Promise<User | null> {
    const token = await this.getToken();
    if (!token) {
      this.user = null;
      this.emitter.fire(null);
      return null;
    }
    try {
      this.user = await this.api.me();
      this.emitter.fire(this.user);
      return this.user;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 0)) {
        if (err.status === 401) {
          await this.clear();
        } else {
          this.user = null;
          this.emitter.fire(null);
        }
        return null;
      }
      throw err;
    }
  }

  async login(email: string, password: string): Promise<User> {
    const { user, token } = await this.api.login(email, password);
    await this.setSession(user, token);
    return user;
  }

  async signup(email: string, password: string): Promise<User> {
    const { user, token } = await this.api.signup(email, password);
    await this.setSession(user, token);
    return user;
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // Still drop the local session even if the backend is unreachable.
    }
    await this.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
