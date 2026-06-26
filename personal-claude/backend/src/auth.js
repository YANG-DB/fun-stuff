import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";

// Real Google login gate. The frontend obtains a Google ID token (JWT) via
// Sign in with Google and posts it here; we verify it **server-side** against
// our OAuth client, then issue our own session token (signed with JWT_SECRET)
// that the client sends on every subsequent request.
//
// Note: env is read lazily (inside functions), not at module load — server.js
// calls dotenv.config() in its body, which runs *after* this module is imported.

const SESSION_TTL = "30d";

function clientId() {
  return process.env.GOOGLE_CLIENT_ID || "";
}
function jwtSecret() {
  return process.env.JWT_SECRET || "";
}

/** Auth is only enforced when both the client id and a signing secret exist. */
export function authConfigured() {
  return !!clientId() && !!jwtSecret();
}

/** Verify a Google ID token and return the identity, or throw. */
export async function verifyGoogleCredential(credential) {
  const id = clientId();
  const oauth = new OAuth2Client(id);
  const ticket = await oauth.verifyIdToken({ idToken: credential, audience: id });
  const p = ticket.getPayload();
  if (!p || !p.email) throw new Error("no email in token");
  if (p.email_verified === false) throw new Error("email not verified");
  return {
    sub: p.sub,
    email: p.email.toLowerCase(),
    name: p.name || p.email,
    picture: p.picture || "",
  };
}

/** Issue a signed session token for a verified user. */
export function issueSession(user) {
  return jwt.sign(
    { sub: user.sub, email: user.email, name: user.name, picture: user.picture },
    jwtSecret(),
    { expiresIn: SESSION_TTL },
  );
}

/** Verify a session token; returns the user payload or null. */
export function verifySession(token) {
  try {
    return jwt.verify(token, jwtSecret());
  } catch {
    return null;
  }
}
