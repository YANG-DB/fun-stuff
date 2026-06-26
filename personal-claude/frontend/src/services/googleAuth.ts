import type { GoogleIdentity } from "../types";

// "Sign in with Google" — identity only (name, email, avatar), no API scopes.
// Uses Google Identity Services (GIS) entirely client-side: it needs only an
// OAuth Client ID (no client secret, no backend). Set VITE_GOOGLE_CLIENT_ID and
// add http://localhost:3000 as an authorized JavaScript origin in Google Cloud
// Console. With no Client ID configured, a demo connection is used so the flow
// is exercisable locally.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export function isGoogleConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

let scriptPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if ((window as any).google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Decode the payload of a Google ID token (a JWT) into an identity. */
function decodeIdToken(jwt: string): GoogleIdentity {
  const payload = jwt.split(".")[1];
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const claims = JSON.parse(decodeURIComponent(escape(json)));
  return {
    sub: claims.sub,
    email: claims.email ?? "",
    name: claims.name ?? claims.email ?? "Google user",
    picture: claims.picture ?? "",
    connectedAt: Date.now(),
  };
}

/**
 * Render the official "Sign in with Google" button into `container`.
 * On success, `onIdentity` receives the linked identity. Returns a cleanup fn.
 */
export async function renderGoogleButton(
  container: HTMLElement,
  onIdentity: (id: GoogleIdentity) => void,
  onError: (msg: string) => void,
): Promise<void> {
  try {
    await loadGis();
    const google = (window as any).google;
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp: { credential?: string }) => {
        if (!resp.credential) return onError("No credential returned");
        try {
          onIdentity(decodeIdToken(resp.credential));
        } catch {
          onError("Could not read Google identity");
        }
      },
    });
    google.accounts.id.renderButton(container, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
    });
  } catch (e) {
    onError((e as Error).message);
  }
}

/**
 * Render the Google button for the LOGIN gate. Unlike renderGoogleButton, this
 * returns the raw ID-token credential so the backend can verify it server-side.
 */
export async function renderGoogleLogin(
  container: HTMLElement,
  onCredential: (credential: string) => void,
  onError: (msg: string) => void,
): Promise<void> {
  try {
    await loadGis();
    const google = (window as any).google;
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (resp: { credential?: string }) => {
        if (resp.credential) onCredential(resp.credential);
        else onError("No credential returned");
      },
    });
    google.accounts.id.renderButton(container, {
      type: "standard",
      theme: "filled_blue",
      size: "large",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
    });
  } catch (e) {
    onError((e as Error).message);
  }
}

/** Fabricate a believable identity for local demo when no Client ID is set. */
export function demoConnect(profileName: string): GoogleIdentity {
  const handle = profileName.toLowerCase().replace(/\s+/g, ".");
  return {
    sub: `demo-${Math.random().toString(36).slice(2, 12)}`,
    email: `${handle}@gmail.com`,
    name: profileName,
    picture: "",
    connectedAt: Date.now(),
  };
}
