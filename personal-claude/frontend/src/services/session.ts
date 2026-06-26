// Stores the backend session token (issued after Google verification) so it can
// be attached to every API request and survive reloads.

const KEY = "personal-claude:session";

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  localStorage.setItem(KEY, token);
}

export function clearToken() {
  localStorage.removeItem(KEY);
}
