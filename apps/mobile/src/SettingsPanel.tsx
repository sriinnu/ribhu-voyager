import { useEffect, useState } from "react";

import {
  notificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  type NotificationSupport,
} from "./notifications";
import { session } from "./session";
import { tokenStorageLabel } from "./storage";

/**
 * Compact gateway + notifications section inside the Session sheet.
 *
 * The gateway URL and token are drafts until "Save & reconnect", which
 * validates the URL, persists both, and reconnects the socket. The token is
 * kept in localStorage today (see storage.ts) — this panel says so instead of
 * implying native secure storage.
 */
export function SettingsPanel({
  gateway,
  token,
}: {
  gateway: string;
  token: string;
}) {
  const [gatewayDraft, setGatewayDraft] = useState(gateway);
  const [tokenDraft, setTokenDraft] = useState(token);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notif, setNotif] = useState<NotificationSupport>(() =>
    notificationPermission(),
  );

  // Keep drafts in sync when the session applies new settings (save/reset).
  useEffect(() => {
    setGatewayDraft(gateway);
    setTokenDraft(token);
  }, [gateway, token]);

  const edit = (fn: () => void) => {
    fn();
    setError(null);
    setSaved(false);
  };

  const save = () => {
    const failure = session.saveGateway(gatewayDraft, tokenDraft);
    setError(failure);
    setSaved(failure === null);
  };

  const enableNotifications = async () => {
    setNotif(await requestNotificationPermission());
  };

  const supported = notificationsSupported();
  const mixedContent =
    window.location.protocol === "https:" &&
    gatewayDraft.trim().toLowerCase().startsWith("http://");

  return (
    <section className="settings" aria-label="Gateway settings">
      <div className="conv-head">
        <h3>Gateway</h3>
        <button
          type="button"
          className="conv-new"
          onClick={() =>
            edit(() => {
              setGatewayDraft(window.location.origin);
              setTokenDraft(token);
            })
          }
        >
          Use this origin
        </button>
      </div>

      <label className="settings-field">
        <span>Server URL</span>
        <input
          className="conv-search"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={gatewayDraft}
          placeholder="https://gateway.example.com"
          aria-label="Gateway server URL"
          onChange={(event) =>
            edit(() => setGatewayDraft(event.target.value))
          }
        />
      </label>

      <label className="settings-field">
        <span>Access token</span>
        <span className="settings-token">
          <input
            className="conv-search"
            type={showToken ? "text" : "password"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={tokenDraft}
            placeholder={token === "" ? "No token saved" : "Token saved"}
            aria-label="Gateway access token"
            onChange={(event) =>
              edit(() => setTokenDraft(event.target.value))
            }
          />
          <button
            type="button"
            className="settings-reveal"
            aria-pressed={showToken}
            onClick={() => setShowToken((value) => !value)}
          >
            {showToken ? "Hide" : "Show"}
          </button>
        </span>
      </label>

      <p className="fine settings-hint">
        Every WebSocket URL derives from this server · token storage:{" "}
        {tokenStorageLabel()}.
      </p>

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {mixedContent ? (
        <p className="settings-error" role="status">
          This page is https, so the browser blocks a ws:// connection to an http
          gateway. Use an https:// gateway URL.
        </p>
      ) : null}
      {saved && !error ? (
        <p className="settings-saved" role="status">
          Saved — reconnecting.
        </p>
      ) : null}

      <button type="button" className="settings-save" onClick={save}>
        Save &amp; reconnect
      </button>

      <div className="conv-head">
        <h3>Notifications</h3>
      </div>
      {!supported ? (
        <p className="fine">
          This browser has no Notification API. Server push is not implemented.
        </p>
      ) : notif === "granted" ? (
        <p className="fine">
          Enabled — a local alert appears if an approval arrives while the app is
          in the background.
        </p>
      ) : notif === "denied" ? (
        <p className="fine">
          Blocked for this site. Re-enable notifications in your browser settings.
        </p>
      ) : (
        <button
          type="button"
          className="settings-save"
          onClick={() => void enableNotifications()}
        >
          Enable notifications
        </button>
      )}
      <p className="fine settings-hint">
        Local browser notifications only — no push/VAPID, APNs or FCM yet, and
        nothing arrives while the app is closed.
      </p>
    </section>
  );
}
