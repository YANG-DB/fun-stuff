// Firebase Auth gate for BC Car Finder.
// Web SDK config keys are public — security comes from Firebase Auth + Auth Rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
  projectId:         "bc-car-finder",
  appId:             "1:181702949752:web:b2ae57a379fe9863fb268d",
  storageBucket:     "bc-car-finder.firebasestorage.app",
  apiKey:            "AIzaSyCztP3QpkjNjqYGrdA-ezbFvOctve38mvE",
  authDomain:        "bc-car-finder.firebaseapp.com",
  messagingSenderId: "181702949752",
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// ── inject CSS + sign-in overlay ──────────────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  body.unauthed .container { display: none !important; }
  #auth-overlay {
    position: fixed; inset: 0; z-index: 10000;
    background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
    display: flex; align-items: center; justify-content: center; padding: 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  body.authed #auth-overlay { display: none; }
  .auth-modal {
    background: #fff; border-radius: 16px; padding: 36px 40px;
    width: 100%; max-width: 400px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .auth-modal h1 { font-size: 1.5em; margin-bottom: 6px; color: #1e3c72; }
  .auth-modal .sub { color: #6b7280; margin-bottom: 22px; font-size: 0.92em; }
  #auth-form input {
    width: 100%; padding: 11px 13px; margin-bottom: 12px;
    border: 1px solid #c8d2e0; border-radius: 8px; font-size: 0.95em;
    font-family: inherit;
  }
  #auth-form input:focus { outline: none; border-color: #2a5298; }
  .auth-error {
    color: #b91c1c; font-size: 0.85em; min-height: 1.2em;
    margin-bottom: 8px; line-height: 1.3;
  }
  .auth-buttons { display: flex; gap: 8px; }
  .auth-buttons button {
    flex: 1; padding: 11px; border-radius: 8px; cursor: pointer;
    border: 1px solid #c8d2e0; background: #fff; color: #2a5298;
    font-size: 0.93em; font-weight: 600; font-family: inherit;
  }
  .auth-buttons button.primary { background: #2a5298; color: #fff; border-color: #2a5298; }
  .auth-buttons button.primary:hover { background: #1e3c72; }
  .auth-buttons button:hover:not(.primary) { background: #f5f7fb; }
  .auth-buttons button:disabled { opacity: 0.5; cursor: wait; }
  #signout-btn {
    position: fixed; top: 16px; right: 16px; z-index: 9999;
    background: rgba(255,255,255,0.95); color: #2a5298;
    border: 1px solid #c8d2e0; padding: 6px 12px; border-radius: 8px;
    cursor: pointer; font-size: 0.85em; font-weight: 600;
    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #signout-btn:hover { background: #2a5298; color: #fff; }
  @media print { #auth-overlay, #signout-btn { display: none !important; } }
`;
document.head.appendChild(style);

document.body.classList.add("unauthed");

const overlay = document.createElement("div");
overlay.id = "auth-overlay";
overlay.innerHTML = `
  <div class="auth-modal">
    <h1>🚗 BC Car Finder</h1>
    <div class="sub">Sign in to view your car-deal dashboard.</div>
    <form id="auth-form" autocomplete="on">
      <input type="email" name="email" placeholder="Email" required autocomplete="email">
      <input type="password" name="password" placeholder="Password (≥ 6 chars)" required autocomplete="current-password" minlength="6">
      <div class="auth-error" id="auth-error"></div>
      <div class="auth-buttons">
        <button type="submit" class="primary" id="signin-btn">Sign in</button>
        <button type="button" id="signup-btn">Create account</button>
      </div>
    </form>
  </div>`;
document.body.appendChild(overlay);

// ── sign-out button ───────────────────────────────────────────────────────────
function ensureSignOut() {
  if (document.getElementById("signout-btn")) return;
  const b = document.createElement("button");
  b.id = "signout-btn";
  b.textContent = "↪ Sign out";
  b.onclick = () => signOut(auth);
  document.body.appendChild(b);
}
function removeSignOut() {
  const b = document.getElementById("signout-btn");
  if (b) b.remove();
}

// ── auth state listener ───────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  if (user) {
    document.body.classList.remove("unauthed");
    document.body.classList.add("authed");
    ensureSignOut();
  } else {
    document.body.classList.remove("authed");
    document.body.classList.add("unauthed");
    removeSignOut();
  }
});

// ── form handlers ─────────────────────────────────────────────────────────────
function friendly(code) {
  return ({
    "auth/invalid-credential":     "Wrong email or password.",
    "auth/wrong-password":         "Wrong email or password.",
    "auth/user-not-found":         "No account with that email — try Create account.",
    "auth/email-already-in-use":   "Account already exists — try Sign in.",
    "auth/invalid-email":          "That doesn't look like a valid email.",
    "auth/weak-password":          "Password too short (6+ chars).",
    "auth/too-many-requests":      "Too many tries — wait a minute and retry.",
    "auth/network-request-failed": "Network error — check your connection.",
    "auth/operation-not-allowed":  "Email/password sign-in is disabled in this Firebase project. Enable it in the console first.",
    "auth/admin-restricted-operation": "Sign-up is disabled. Contact the site owner if you need access.",
  })[code];
}

const form = document.getElementById("auth-form");
const err  = document.getElementById("auth-error");
const signInBtn = document.getElementById("signin-btn");
const signUpBtn = document.getElementById("signup-btn");

function setBusy(b) {
  signInBtn.disabled = b;
  signUpBtn.disabled = b;
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  err.textContent = "";
  setBusy(true);
  try {
    await signInWithEmailAndPassword(auth, form.email.value, form.password.value);
  } catch (ex) {
    err.textContent = friendly(ex.code) || ex.message;
  } finally { setBusy(false); }
});

signUpBtn.addEventListener("click", async () => {
  err.textContent = "";
  if (!form.email.value || !form.password.value) {
    err.textContent = "Email + password required."; return;
  }
  if (form.password.value.length < 6) {
    err.textContent = "Password must be at least 6 characters."; return;
  }
  setBusy(true);
  try {
    await createUserWithEmailAndPassword(auth, form.email.value, form.password.value);
  } catch (ex) {
    err.textContent = friendly(ex.code) || ex.message;
  } finally { setBusy(false); }
});
