// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Check, CirclePause, Cloud, KeyRound, LogIn, LogOut, Play, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { OutpostApi, type OutpostStatus, type SourceStatus } from "./api-client.js";
import "./app.css";

const runtimeConfig = window as Window & { __ATF_CONTROL_URL__?: string; __ATF_CONTROL_TOKEN__?: string };
type ControlEndpoint = { url: string; token: string };

function injectedEndpoint(): ControlEndpoint | null {
  const url = import.meta.env.VITE_OUTPOST_CONTROL_URL ?? runtimeConfig.__ATF_CONTROL_URL__;
  const token = import.meta.env.VITE_OUTPOST_CONTROL_TOKEN ?? runtimeConfig.__ATF_CONTROL_TOKEN__;
  return url !== undefined && token !== undefined ? { url, token } : null;
}

/// Port/Token des Sidecars sind erst nach dem Start bekannt: innerhalb von
/// Tauri pollt das WebView den Command `control_info`, bis er bereit ist.
function useControlEndpoint(): ControlEndpoint | null {
  const [endpoint, setEndpoint] = useState<ControlEndpoint | null>(injectedEndpoint);
  useEffect(() => {
    if (endpoint !== null || !("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      invoke<ControlEndpoint | null>("control_info").then((info) => {
        if (!cancelled && info !== null) setEndpoint(info);
      }).catch(() => undefined);
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [endpoint]);
  return endpoint;
}

type ApiOperation = (client: OutpostApi) => Promise<unknown>;

/** Runs an operation against the Control API; the buttons are disabled while it is absent. */
function withClient(api: OutpostApi | null, operation: ApiOperation): () => Promise<void> {
  return async () => {
    if (api === null) throw new Error("Control-API ist noch nicht konfiguriert.");
    await operation(api);
  };
}

function App(): ReactElement {
  const [status, setStatus] = useState<OutpostStatus | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("Bereit");
  const [busy, setBusy] = useState(false);
  const endpoint = useControlEndpoint();
  const api = useMemo(() => (endpoint !== null ? new OutpostApi(endpoint.url, endpoint.token) : null), [endpoint]);

  const refresh = useCallback(async (): Promise<void> => {
    if (api === null) { setMessage("Control-API ist noch nicht konfiguriert."); return; }
    try { const [nextStatus, nextConfig] = await Promise.all([api.status(), api.config()]); setStatus(nextStatus); setConfig(nextConfig); setMessage("Status aktualisiert"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Control-API nicht erreichbar"); }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (api === null) return;
    const controller = new AbortController();
    void api.events((event) => { setMessage(event.event.replaceAll(".", " ")); void refresh(); }, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [api, refresh]);

  const action = async (operation: () => Promise<void>, success: string): Promise<void> => {
    setBusy(true);
    try { await operation(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Aktion fehlgeschlagen"); }
    finally { setBusy(false); }
  };
  const withApi = (operation: ApiOperation) => withClient(api, operation);

  return <div className="shell">
    <header className="masthead"><div><p className="eyebrow"><Activity size={15} /> Extract Outpost</p><h1>Sync, der im Hintergrund Ruhe gibt.</h1><p className="lede">Lokale Ordner und Cloud-Quellen. Ein klarer Status, ein sicherer nächster Schritt.</p></div><div className="health" aria-live="polite"><span className={status === null ? "dot idle" : "dot online"} /> {message}</div></header>
    <section className="toolbar" aria-label="Globale Aktionen"><button type="button" className="primary" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.resume()), "Synchronisation fortgesetzt")}><Play size={16} /> Fortsetzen</button><button type="button" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.pause()), "Synchronisation pausiert")}><CirclePause size={16} /> Pausieren</button><button type="button" disabled={busy || api === null} onClick={() => void action(refresh, "Status aktualisiert")}><RefreshCw size={16} /> Aktualisieren</button><button type="button" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.login()), "Anmeldung gestartet")}><LogIn size={16} /> Extract anmelden</button><button type="button" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.logout()), "Abgemeldet")}><LogOut size={16} /> Abmelden</button></section>
    {config !== null && api !== null && <Settings config={config} api={api} busy={busy} action={action} />}
    <main><div className="section-heading"><div><p className="eyebrow">Quellen</p><h2>Dein Datenstrom</h2></div><span className="count">{status?.sources.length ?? 0} Quellen</span></div>{status?.sources.length === 0 ? <div className="empty"><Cloud size={28} /><p>Noch keine Quellen konfiguriert.</p></div> : <div className="source-grid">{status?.sources.map((source) => <SourceCard key={source.sourceId} source={source} api={api} busy={busy} action={action} />)}</div>}</main>
    <footer><ShieldAlert size={15} /> Zugangsdaten werden nur über die lokale Control-API verarbeitet und nie im UI-Status gespeichert.</footer>
  </div>;
}

function Settings({ config, api, busy, action }: { config: Record<string, unknown>; api: OutpostApi; busy: boolean; action: (operation: () => Promise<void>, success: string) => Promise<void> }): ReactElement {
  const [extractUrl, setExtractUrl] = useState(String(config.extractUrl ?? ""));
  const [collection, setCollection] = useState(String(config.collection ?? ""));
  const [interval, setInterval] = useState(String(config.syncIntervalSec ?? 900));
  const [mirrorDelete, setMirrorDelete] = useState(Boolean(config.mirrorDelete));
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void action(() => api.updateConfig({ ...config, extractUrl, collection, syncIntervalSec: Number(interval), mirrorDelete }), "Einstellungen gespeichert");
  };
  return <section className="settings-panel" aria-labelledby="settings-heading"><h2 id="settings-heading">Einstellungen</h2><form className="settings" onSubmit={save}><div><label htmlFor="extract-url">Extract URL</label><input id="extract-url" value={extractUrl} onChange={(event) => setExtractUrl(event.target.value)} /></div><div><label htmlFor="collection">Collection</label><input id="collection" value={collection} onChange={(event) => setCollection(event.target.value)} /></div><div><label htmlFor="interval">Intervall (Sekunden)</label><input id="interval" type="number" min="1" value={interval} onChange={(event) => setInterval(event.target.value)} /></div><label className="toggle"><input type="checkbox" checked={mirrorDelete} onChange={(event) => setMirrorDelete(event.target.checked)} /> Mirror Delete</label><button type="submit" className="primary" disabled={busy}>Einstellungen speichern</button></form></section>;
}

function SourceCard({ source, api, busy, action }: { source: SourceStatus; api: OutpostApi | null; busy: boolean; action: (operation: () => Promise<void>, success: string) => Promise<void> }): ReactElement {
  const [secret, setSecret] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const withApi = (operation: ApiOperation) => withClient(api, operation);
  const needsAuth = source.status === "needs-authorization";
  const canAuthorize = source.type === "gdrive" && source.auth !== "service-account" || source.type === "dropbox";
  const canSetCredentials = source.type === "s3" || source.type === "gdrive" && source.auth === "service-account";
  const submitCredential = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (api === null) return;
    if (source.type === "s3" ? accessKey === "" || secretAccessKey === "" : secret === "") return;
    void action(async () => {
      if (source.type === "s3") {
        await api.credentials(source.sourceId, { kind: "s3-access-key", accessKeyId: accessKey, secretAccessKey });
        setAccessKey(""); setSecretAccessKey("");
      } else {
        await api.credentials(source.sourceId, { kind: "gdrive-service-account", keyJson: secret });
        setSecret("");
      }
    }, "Zugangsdaten hinterlegt");
  };
  return <article className={`source-card ${needsAuth ? "attention" : ""}`}>
    <div className="source-top"><div className="source-icon"><Cloud size={19} /></div><div><h3>{source.sourceId}</h3><p>{source.lastRun?.finishedAt === undefined ? "Noch kein Lauf" : `Letzter Lauf ${new Date(source.lastRun.finishedAt).toLocaleString("de-DE")}`}</p></div><span className={`status status-${source.status}`}>{source.status}</span></div>
    <div className="metrics"><span><strong>{source.lastRun?.counters.updated ?? 0}</strong> aktualisiert</span><span><strong>{source.lastRun?.counters.failed ?? 0}</strong> Fehler</span><span><strong>{source.credentials?.configured ? "Ja" : "Nein"}</strong> Credentials</span></div>
    <div className="actions"><button type="button" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.sync(source.sourceId)), "Sync gestartet")}><RefreshCw size={15} /> Jetzt syncen</button>{source.status === "awaiting-confirmation" && <button type="button" className="primary" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.confirmDelete(source.sourceId)), "Löschung bestätigt")}><Check size={15} /> Löschung bestätigen</button>}{canAuthorize && <button type="button" className={needsAuth ? "primary" : ""} disabled={busy || api === null} onClick={() => void action(withApi((client) => client.authorize(source.sourceId)), "Autorisierung geöffnet")}><KeyRound size={15} /> {needsAuth ? "Erneut autorisieren" : "Autorisieren"}</button>}</div>
    {needsAuth && <p className="callout"><ShieldAlert size={16} /> Diese Quelle benötigt eine neue Autorisierung.</p>}
    {canSetCredentials && <form className="credential-form" onSubmit={submitCredential}>{source.type === "s3" ? <><label htmlFor={`access-${source.sourceId}`}>S3 Access-Key-ID</label><input id={`access-${source.sourceId}`} type="password" autoComplete="off" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} /><label htmlFor={`secret-${source.sourceId}`}>S3 Secret-Access-Key</label><input id={`secret-${source.sourceId}`} type="password" autoComplete="off" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /></> : <><label htmlFor={`secret-${source.sourceId}`}>Dienstkonto-JSON</label><textarea id={`secret-${source.sourceId}`} value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" placeholder="Nur für GDrive service-account" /></>}<div><button type="submit" disabled={busy || api === null || (source.type === "s3" ? accessKey === "" || secretAccessKey === "" : secret === "")}><Check size={15} /> Hinterlegen</button><button type="button" className="danger" disabled={busy || api === null} onClick={() => void action(withApi((client) => client.removeCredentials(source.sourceId)), "Zugangsdaten entfernt")}><Trash2 size={15} /> Entfernen</button></div></form>}
  </article>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Root-Element fehlt");
import("react-dom/client").then(({ createRoot }) => createRoot(root).render(<App />));
