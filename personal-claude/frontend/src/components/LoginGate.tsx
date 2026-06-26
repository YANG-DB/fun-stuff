import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { isGoogleConfigured, renderGoogleLogin } from "../services/googleAuth";

// The login gate: you must sign in with Google before reaching the profiles.
// The button yields a Google ID token, which the backend verifies and exchanges
// for a session token; only then are accessible profiles loaded.
export function LoginGate() {
  const { login } = useStore();
  const btnRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!btnRef.current || !isGoogleConfigured()) return;
    renderGoogleLogin(
      btnRef.current,
      async (credential) => {
        setBusy(true);
        setError(null);
        try {
          await login(credential);
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      },
      (msg) => setError(msg),
    );
  }, [login]);

  return (
    <div className="gate">
      <div className="login-card">
        <div className="brand">
          <img className="brand-logo" src="/favicon.svg" alt="" /> Personal Claude
        </div>
        <h1>Sign in to continue</h1>
        <p className="gate-sub">
          Your conversations stay private to your profiles. Sign in with Google to
          see the profiles you're allowed to open.
        </p>

        <div className="login-btn-wrap">
          {isGoogleConfigured() ? (
            <div ref={btnRef} />
          ) : (
            <p className="settings-error">
              Google sign-in isn't configured (missing VITE_GOOGLE_CLIENT_ID).
            </p>
          )}
        </div>

        {busy && <p className="gate-sub">Verifying…</p>}
        {error && <p className="settings-error">{error}</p>}
      </div>
    </div>
  );
}
