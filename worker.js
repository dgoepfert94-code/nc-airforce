/**
 * Cloudflare Worker: nimmt die bearbeitete HTML-Seite entgegen
 * und committet sie per GitHub-Contents-API direkt ins Repo.
 * GitHub Pages baut die Seite danach automatisch neu.
 *
 * Benötigte Secrets/Vars (siehe README.md für Einrichtung):
 *   GITHUB_TOKEN   -> Fine-grained PAT mit "Contents: Read and write" auf das Repo
 *   GITHUB_OWNER   -> z.B. "meinorg"
 *   GITHUB_REPO    -> z.B. "meine-seite"
 *   GITHUB_BRANCH  -> z.B. "main"
 *   GITHUB_PATH    -> z.B. "index.html"
 *   SAVE_SECRET    -> geheimer Code, den nur Mitarbeiter kennen (Frontend schickt ihn im Header)
 *
 * ACHTUNG: dieser Worker ist absichtlich schlank für ein internes Team gehalten
 * (ein gemeinsames Secret statt Nutzerverwaltung). Für mehr Sicherheit könnte
 * man SAVE_SECRET durch echte Zugangstoken pro Mitarbeiter ersetzen.
 */

const ALLOWED_ORIGIN = '*'; // bei Bedarf auf eure GitHub-Pages-Domain einschränken, z.B. 'https://meinorg.github.io'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Save-Secret',
  };
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    const providedSecret = request.headers.get('X-Save-Secret') || '';
    if (!env.SAVE_SECRET || providedSecret !== env.SAVE_SECRET) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders() });
    }

    const html = payload && payload.html;
    if (!html || typeof html !== 'string') {
      return new Response('Missing "html" field', { status: 400, headers: corsHeaders() });
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || 'main';
    const path = env.GITHUB_PATH || 'index.html';
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'cloudflare-worker-save-page',
    };

    try {
      // 1. Aktuelle SHA der Datei holen (nötig, um ein Update statt Create zu machen)
      let sha;
      const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders });
      if (getRes.ok) {
        const getData = await getRes.json();
        sha = getData.sha;
      } else if (getRes.status !== 404) {
        const errText = await getRes.text();
        throw new Error(`GitHub GET fehlgeschlagen (${getRes.status}): ${errText}`);
      }

      // 2. Neue Datei committen
      const contentBytes = new TextEncoder().encode(html);
      const contentBase64 = uint8ToBase64(contentBytes);

      const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Seite bearbeitet über Mitarbeiter-Editor (${new Date().toISOString()})`,
          content: contentBase64,
          branch,
          ...(sha ? { sha } : {}),
        }),
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(`GitHub PUT fehlgeschlagen (${putRes.status}): ${errText}`);
      }

      const putData = await putRes.json();
      return new Response(JSON.stringify({ ok: true, commit: putData.commit && putData.commit.sha }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};
