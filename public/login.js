const $ = (id) => document.getElementById(id);
let signup = false;

function render() {
  $('heading').textContent = signup ? 'Create your workspace' : 'Sign in';
  $('go').textContent = signup ? 'Create account' : 'Sign in';
  $('toggle').textContent = signup ? 'I have an account' : 'Create account';
  $('workspace').classList.toggle('hidden', !signup);
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('hint').textContent = signup ? 'Free trial, no card needed.' : '';
  $('err').textContent = '';
}
$('toggle').onclick = () => { signup = !signup; render(); };

async function submit() {
  $('err').textContent = '';
  $('go').disabled = true;
  try {
    const r = await fetch(signup ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value, workspaceName: $('workspace').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    // New accounts see their API key once; keep it for the app to display
    if (j.apiKey) sessionStorage.setItem('newApiKey', j.apiKey);
    location.href = '/';
  } catch (e) {
    $('err').textContent = e.message;
  } finally {
    $('go').disabled = false;
  }
}
$('go').onclick = submit;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
render();
