// Reads the newest sign-in code sent to EMAIL from local Supabase's Mailpit (spec 5: the dev
// sign-in stub). The sign-in screen only shows the code step once the email has gone, so the first
// look usually finds it; the retries cover a slow inbox.
const url = 'http://127.0.0.1:55324/api/v1/search?limit=1&query=' + encodeURIComponent('to:' + EMAIL);

let code = null;
for (let attempt = 0; attempt < 50 && !code; attempt++) {
  const response = http.get(url);
  if (!response.ok) continue;
  const messages = json(response.body).messages;
  const match = messages.length > 0 ? /\b(\d{6})\b/.exec(messages[0].Snippet) : null;
  if (match) code = match[1];
}
if (!code) throw new Error('No sign-in code in Mailpit for ' + EMAIL);
output.code = code;
