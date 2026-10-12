'use strict';
const $ = id => document.getElementById(id);
const staticSetup = !!document.querySelector('meta[name="prosigma-static"]');
let config, selected = [], busy = false, cancelled = false, currentTransfer = null, pendingAction = null, page = null, deleteId = null, toastTimer;
const fmt = bytes => { if (!bytes) return '0 B'; const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** i).toLocaleString('tr-TR', {maximumFractionDigits: i ? 1 : 0})} ${['B','KiB','MiB','GiB'][i]}`; };
const date = ts => new Date(ts).toLocaleString('tr-TR', {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(path, options = {}) {
  if (staticSetup) throw new Error('Dosya paylaşım hizmeti henüz kullanıma açılmadı.');
  const headers = {...options.headers};
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {credentials: 'same-origin', signal: AbortSignal.timeout(120000), ...options, headers});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(data.error || 'Bağlantı kurulamadı. Yeniden deneyin.'); error.status = res.status; throw error; }
  return data;
}
function shareURL(token) { const url = new URL('./', location.href); url.hash = `t=${token}`; return url.href; }
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('Paylaşım bağlantısı kopyalandı.'); } catch { toast('Otomatik kopyalama kullanılamıyor. Bağlantıyı seçip kopyalayın.'); } }
function info(title, paragraphs) {
  $('info-title').textContent = title; $('info-body').replaceChildren();
  paragraphs.forEach(text => { const p = document.createElement('p'); p.textContent = text; $('info-body').append(p); });
  $('info-dialog').showModal();
}
function setupInfo() { info('Drive bağlantı kurulumu.', ['Uygulama yöneticisi proje klasöründe npm run setup komutunu çalıştırmalı. Kurulum, Google’ın kendi izin ekranından Drive erişimi ister ve yalnızca bu uygulamanın oluşturduğu dosyaları kullanır.', 'Google Cloud projesinde Drive API ve masaüstü OAuth istemcisi gerekir. Kurulum sihirbazı istemci bilgilerini yalnızca bu bilgisayarda alır; sohbet üzerinden parola veya token göndermenize gerek yoktur.', 'Google bağlantısından sonra npm run deploy ile Cloudflare’a yayınlanır. Ayrıntılı adımlar projenin README dosyasında.']); }
function show(view) {
  if (busy) { toast('Önce devam eden aktarımı tamamlayın veya iptal edin.'); return false; }
  for (const name of ['send', 'history', 'receive', 'users']) $(`${name}-view`).hidden = name !== view;
  $('users-nav').classList.toggle('active', view === 'users'); $('send-nav').classList.toggle('active', view === 'send'); $('history-nav').classList.toggle('active', view === 'history'); return true;
}
function requireLogin(action) {
  if (!config?.configured) { setupInfo(); return; }
  if (config.loggedIn) { action(); return; }
  pendingAction = action; $('login-error').textContent = '';
  $('username').value = 'admin'; $('password').value = config.demo ? 'demo-password-only-local-1234' : '';
  $('demo-password').hidden = !config.demo; $('login-dialog').showModal();
}
function accountLabel() { $('account-label').textContent = config.loggedIn ? (config.role === 'owner' ? 'Yönetici · Çıkış' : `${config.username} · Çıkış`) : 'Gönderici girişi'; $('account').classList.toggle('connected', config.loggedIn); $('users-nav').hidden = !(config.loggedIn && config.role === 'owner'); }
function fileRow(file, remove, download) {
  const row = document.createElement('div'); row.className = 'file-row';
  const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = file.name.includes('.') ? file.name.split('.').pop().slice(0, 5) : 'FILE';
  const desc = document.createElement('div'); desc.className = 'file-description';
  const name = document.createElement('strong'); name.textContent = file.name; name.title = file.name;
  const size = document.createElement('small'); size.textContent = fmt(file.size); desc.append(name,size); row.append(icon,desc);
  if (remove) { const button = document.createElement('button'); button.type = 'button'; button.className = 'remove-file'; button.textContent = '×'; button.setAttribute('aria-label', `${file.name} dosyasını kaldır`); button.onclick = remove; row.append(button); }
  if (download) { const a = document.createElement('a'); a.className = 'download-button'; a.textContent = '↓'; a.href = download; a.download = file.name; a.setAttribute('aria-label', `${file.name} indir`); row.append(a); }
  return row;
}
function renderFiles() {
  $('file-list').replaceChildren(...selected.map((f,i) => fileRow(f, () => { selected.splice(i,1); renderFiles(); })));
  $('selection-meta').hidden = !selected.length; $('selection-total').textContent = `${selected.length} dosya · ${fmt(selected.reduce((n,f) => n + f.size, 0))}`;
}
function addFiles(files) {
  if (busy || staticSetup) return;
  let total = selected.reduce((n,f) => n + f.size, 0), rejected = [];
  for (const file of files) {
    if (!file.size) { rejected.push(`${file.name}: boş dosya`); continue; }
    if (file.name.length > 200 || /[\x00-\x1f]/.test(file.name)) { rejected.push('Dosya adı çok uzun veya geçersiz'); continue; }
    if (selected.length >= 20 || file.size > (config?.maxFile || 2 * 1024 ** 3) || total + file.size > (config?.maxTotal || 5 * 1024 ** 3)) { rejected.push(`${file.name}: aktarım sınırını aşıyor`); continue; }
    if (selected.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) continue;
    selected.push(file); total += file.size;
  }
  renderFiles(); if (rejected.length) toast(rejected.slice(0, 2).join(' · '));
}
function progress(done, total, file) { const value = Math.min(100, Math.floor(done / total * 100)); $('progress').value = value; $('progress-percent').textContent = `%${value}`; $('progress-file').textContent = file; $('progress-description').textContent = `${fmt(done)} / ${fmt(total)} yüklendi.`; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function uploadFile(file, index, total, already) {
  const {ticket} = await api(`/transfers/${currentTransfer}/upload`, {method: 'POST', body: JSON.stringify({index})});
  let offset = 0, failures = 0;
  while (offset < file.size) {
    if (cancelled) throw new Error('Aktarım iptal edildi.');
    const end = Math.min(offset + config.chunkSize, file.size);
    try {
      const result = await api('/upload', {method: 'PUT', headers: {'X-Upload-Ticket': ticket, 'Content-Type':'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`}, body: file.slice(offset,end)});
      if (!Number.isSafeInteger(result.offset) || result.offset <= offset || result.offset > file.size) throw new Error('Yükleme ilerlemesi doğrulanamadı.');
      offset = result.offset; failures = 0; progress(already + offset,total,file.name);
    } catch (error) {
      if (cancelled || [400,401,403,410,413].includes(error.status) || ++failures > 4) throw error;
      $('progress-description').textContent = `Bağlantı kontrol ediliyor… Yeniden deneme ${failures}/4`;
      await sleep(Math.min(1000 * 2 ** failures, 10000));
      if (cancelled) throw new Error('Aktarım iptal edildi.');
      try {
        const status = await api('/upload', {method: 'POST', headers: {'X-Upload-Ticket': ticket}});
        if (!Number.isSafeInteger(status.offset) || status.offset < 0 || status.offset > file.size) throw new Error('Yükleme durumu geçersiz.');
        offset = status.offset; progress(already + offset,total,file.name);
      } catch (check) { if ([401,403,410].includes(check.status)) throw check; }
    }
  }
}
async function send() {
  if (busy || !selected.length) return;
  busy = true; cancelled = false; currentTransfer = null;
  $('transfer-form').hidden = true; $('success-panel').hidden = true; $('progress-panel').hidden = false; $('cancel-upload').disabled = false;
  const total = selected.reduce((n,f) => n + f.size,0); progress(0,total,selected[0].name);
  try {
    const created = await api('/transfers', {method: 'POST', body: JSON.stringify({title:$('title').value,message:$('message').value,days:Number($('days').value),files:selected.map(f => ({name:f.name,size:f.size}))})});
    currentTransfer = created.id; let already = 0;
    for (let i = 0; i < selected.length; i++) { await uploadFile(selected[i],i,total,already); already += selected[i].size; }
    if (cancelled) throw new Error('Aktarım iptal edildi.');
    $('cancel-upload').disabled = true;
    $('progress-description').textContent = 'Dosyalar doğrulanıyor, paylaşım bağlantısı hazırlanıyor…';
    const result = await api(`/transfers/${currentTransfer}/complete`, {method:'POST',body:'{}'});
    $('share-link').value = shareURL(result.token); $('open-share').href = shareURL(result.token);
    $('success-summary').textContent = `${selected.length} dosya · ${fmt(total)} yüklendi. Bağlantıyı alıcınızla paylaşabilirsiniz. İndirme için sizin çevrimiçi olmanız gerekmez.`;
    $('success-expiry').textContent = `${date(result.expires)} tarihine kadar kullanılabilir.`;
    $('progress-panel').hidden = true; $('success-panel').hidden = false; currentTransfer = null;
  } catch (error) {
    if (currentTransfer) {
      try { await api(`/transfers/${currentTransfer}`, {method:'DELETE'}); }
      catch { toast('Yarım aktarım temizlenemedi. Aktarımlar bölümünden silebilirsiniz; otomatik temizlik 24 saat sonra dener.'); }
    }
    $('progress-panel').hidden = true; $('transfer-form').hidden = false; toast(error.message);
    if (error.status === 401) { config.loggedIn = false; accountLabel(); }
  } finally { busy = false; currentTransfer = null; }
}
function reset() { if (busy) return; selected = []; renderFiles(); $('transfer-form').reset(); $('transfer-form').hidden = false; $('success-panel').hidden = true; show('send'); history.replaceState(null,'',location.pathname); }
async function loadHistory(more = false) {
  if (!show('history')) return;
  $('quota').hidden = config.role !== 'owner';
  if (!more) { $('history-list').textContent = 'Aktarımlar yükleniyor…'; page = null; }
  $('more-history').disabled = true;
  try {
    const data = await api(`/transfers${more && page ? '?page=' + encodeURIComponent(page) : ''}`);
    if (!more) $('history-list').replaceChildren();
    if (!data.transfers.length && !more) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; const h = document.createElement('h2'); h.textContent = 'Henüz aktarım bulunmuyor.'; const p = document.createElement('p'); p.textContent = 'Oluşturduğunuz aktarımları bu alandan yönetebilirsiniz.'; empty.append(h,p); $('history-list').append(empty);
    }
    for (const transfer of data.transfers) {
      const row = document.createElement('article'); row.className = 'history-item'; const details = document.createElement('div'); const title = document.createElement('h3'); title.textContent = transfer.title; const meta = document.createElement('p');
      meta.textContent = transfer.expires < Date.now() ? 'Süresi doldu · Temizlik bekleniyor' : `${transfer.state === 'ready' ? 'İndirmeye açık' : 'Tamamlanmamış'} · ${date(transfer.expires)} tarihine kadar`;
      details.append(title,meta); const actions = document.createElement('div'); actions.className = 'history-actions';
      if (transfer.token) { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Bağlantıyı kopyala ↗'; button.onclick = () => copy(shareURL(transfer.token)); actions.append(button); }
      const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Sil'; remove.onclick = () => { deleteId = transfer.id; $('delete-description').textContent = `“${transfer.title}” aktarımı ve içindeki dosyalar kaldırılacak.`; $('delete-dialog').showModal(); }; actions.append(remove); row.append(details,actions); $('history-list').append(row);
    }
    page = data.nextPage; $('more-history').hidden = !page;
    if (!more && config.role === 'owner') {
      try { const quota = await api('/quota'); $('quota').textContent = quota.limit ? `Drive alanı: ${fmt(Number(quota.usage || 0))} / ${fmt(Number(quota.limit))} kullanılıyor · ${fmt(Math.max(0,Number(quota.limit) - Number(quota.usage || 0)))} boş` : `Drive alanı: ${fmt(Number(quota.usage || 0))} kullanılıyor · Hesap toplam kotayı bildirmiyor`; }
      catch { $('quota').textContent = 'Drive alan bilgisi şu anda alınamıyor.'; }
    }
  } catch(error) { if (!more) $('history-list').textContent = error.message; else toast(error.message); if (error.status === 401) { config.loggedIn = false; accountLabel(); } }
  finally { $('more-history').disabled = false; }
}
async function receive() {
  const token = new URLSearchParams(location.hash.slice(1)).get('t'); if (!token) return false;
  show('receive'); $('receive-loading').hidden = false; $('receive-content').hidden = true; $('receive-error').hidden = true;
  try {
    const data = await api(`/share?token=${encodeURIComponent(token)}`);
    $('receive-title').textContent = data.title; $('receive-message').textContent = data.message; $('receive-message').hidden = !data.message;
    $('receive-files').replaceChildren(...data.files.map(f => fileRow(f,null,`/api/download?token=${encodeURIComponent(token)}&file=${encodeURIComponent(f.id)}`)));
    $('receive-expiry').textContent = `${data.files.length} dosya · ${fmt(data.files.reduce((n,f) => n + f.size,0))} · Son indirme: ${date(data.expires)}`;
    $('receive-content').hidden = false;
  } catch(error) { $('receive-error').hidden = false; $('receive-error-text').textContent = error.message; }
  finally { $('receive-loading').hidden = true; } return true;
}
$('transfer-form').onsubmit = event => { event.preventDefault(); if (!selected.length) { toast('Lütfen göndermek istediğiniz dosyaları seçin.'); $('file-input').click(); return; } requireLogin(send); };
$('file-input').onchange = event => { addFiles(event.target.files); event.target.value = ''; };
$('dropzone').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } };
for (const type of ['dragenter','dragover']) $('dropzone').addEventListener(type,event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const type of ['dragleave','drop']) $('dropzone').addEventListener(type,event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop',event => addFiles(event.dataTransfer.files));
window.addEventListener('dragover',event => event.preventDefault()); window.addEventListener('drop',event => event.preventDefault());
$('clear-files').onclick = () => { selected = []; renderFiles(); };
$('cancel-upload').onclick = () => { cancelled = true; $('cancel-upload').disabled = true; $('progress-description').textContent = 'Geçerli parça bitince aktarım iptal edilecek…'; };
$('copy-link').onclick = () => copy($('share-link').value);
$('new-transfer').onclick = reset; $('history-new').onclick = reset;
$('send-nav').onclick = () => { if (show('send')) history.replaceState(null,'',location.pathname); };
$('history-nav').onclick = () => requireLogin(() => loadHistory()); $('more-history').onclick = () => loadHistory(true);
$('account').onclick = async () => { if (busy) { toast('Önce aktarımı tamamlayın veya iptal edin.'); return; } if (config?.loggedIn) { try { await api('/logout',{method:'POST'}); config.loggedIn = false; accountLabel(); show('send'); toast('Oturum kapatıldı.'); } catch(error) { toast(error.message); } } else requireLogin(() => toast('Giriş yapıldı. Dosya gönderebilirsiniz.')); };
$('login-form').onsubmit = async event => { event.preventDefault(); $('login-submit').disabled = true; $('login-error').textContent = ''; try { const login = await api('/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})}); $('password').value = ''; config.loggedIn = true; config.role = login.role; config.username = login.username; accountLabel(); $('login-dialog').close(); const action = pendingAction; pendingAction = null; action?.(); } catch(error) { $('login-error').textContent = error.message; } finally { $('login-submit').disabled = false; } };
$('confirm-delete').onclick = async () => { $('confirm-delete').disabled = true; try { await api(`/transfers/${deleteId}`,{method:'DELETE'}); $('delete-dialog').close(); toast('Aktarım ve dosyaları silindi.'); await loadHistory(); } catch(error) { toast(error.message); } finally { $('confirm-delete').disabled = false; } };
$('about-nav').onclick = () => info('Dosya paylaşımı nasıl çalışır?', ['01 · Dosyalarınızı seçin. Tek aktarımda en fazla 20 dosya, dosya başına 2 GiB ve toplamda 5 GiB gönderebilirsiniz. Kullanılabilir Drive alanı yeterli olmalıdır.', '02 · Paylaşım bağlantısını oluşturun. Dosyalar, yöneticinin Google Drive hesabında bu uygulamaya özel klasöre yüklenir. Başarılı yüklemenin ardından paylaşım bağlantınız hazırlanır.', '03 · Bağlantıyı paylaşın. Alıcının hesap açması veya sizin çevrimiçi kalmanız gerekmez. Saklama süresi dolunca bağlantı kapanır; dosyalar sonraki otomatik temizlikte kalıcı olarak silinir.']);
$('privacy-button').onclick = () => info('Gizlilik ve kullanım.', ['Drive dosyaları herkese açık yapılmaz. İndirme uygulama üzerinden gerçekleşir; paylaşım bağlantısına sahip olan herkes aktarımı indirebilir. Bağlantıyı yalnızca yetkilendirmek istediğiniz kişilerle paylaşın.', 'Drive’daki diğer dosyalar alıcılara açılmaz. Uygulama yalnızca kendi oluşturduğu dosyalar için izin ister. Google erişim bilgileri tarayıcıya veya GitHub’a yazılmaz.', 'Bu hizmet uçtan uca şifreleme sunmaz. Dosyalar aktarım sırasında HTTPS ile korunur; depolama Google Drive’dadır.', 'Drive kapasitesi, Google API sınırları ve Cloudflare ücretsiz planının kotaları geçerlidir. Ücretsiz plan sınırında işlemler durabilir. GitHub yalnızca kaynak kod içindir.', 'Süre dolunca yeni indirmeler engellenir. Saatlik temizlik dosyaları kalıcı olarak siler; hizmet kotası dolmuşsa silme gecikebilir. Başlamış indirmeler ve alıcının aldığı kopyalar geri alınamaz.']);
$('setup-help').onclick = setupInfo;
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
let pendingUserAction = null;
function showCredentials(user, password) {
  $('credential-value').value = `PROSİGMA Transfer\nKullanıcı adı: ${user.username}\nE-posta: ${user.email}\nParola: ${password}`;
  $('credential-dialog').showModal();
}
async function loadUsers() {
  if (config.role !== 'owner' || !show('users')) return;
  $('users-list').textContent = 'Kullanıcılar yükleniyor…';
  try {
    const {users} = await api('/users'); $('users-list').replaceChildren();
    if (!users.length) { const p = document.createElement('p'); p.className = 'empty-state'; p.textContent = 'Henüz ek gönderici hesabı yok. Şu anda yalnızca yönetici dosya gönderebilir.'; $('users-list').append(p); }
    for (const user of users) {
      const row = document.createElement('article'); row.className = 'history-item';
      const details = document.createElement('div'), title = document.createElement('h3'), subtitle = document.createElement('p');
      title.textContent = user.name || user.username; subtitle.textContent = `${user.username} · ${user.email} · ${user.state === 'active' ? 'Erişim açık' : 'Erişim kapalı'}`; details.append(title,subtitle);
      const actions = document.createElement('div'); actions.className = 'history-actions';
      for (const type of ['toggle','reset']) { const button = document.createElement('button'); button.className='secondary'; button.textContent = type === 'reset' ? 'Parolayı yenile' : user.state === 'active' ? 'Erişimi kapat' : 'Erişimi aç';
        button.onclick = () => { pendingUserAction = {user,type}; $('user-action-title').textContent = type === 'reset' ? 'Yeni parola oluşturulsun mu?' : user.state === 'active' ? 'Kullanıcı erişimi kapatılsın mı?' : 'Kullanıcı erişimi açılsın mı?'; $('user-action-text').textContent = type === 'reset' ? `${user.username} kullanıcısının mevcut parolası ve açık oturumları geçersiz kılınır. Yeni parola bir kez gösterilir.` : `${user.username} kullanıcısının oturumları kapatılır. Önceden paylaşılan indirme bağlantıları, aktarımları silmediğiniz sürece geçerliliğini korur.`; $('user-action-dialog').showModal(); }; actions.append(button); }
      row.append(details,actions); $('users-list').append(row);
    }
  } catch(error) { $('users-list').textContent=error.message; }
}
$('users-nav').onclick = () => requireLogin(loadUsers);
$('add-user').onclick = () => { $('user-form').reset(); $('user-error').textContent=''; $('user-dialog').showModal(); };
$('user-form').onsubmit = async event => { event.preventDefault(); $('user-submit').disabled = true; $('user-error').textContent=''; try { const result = await api('/users',{method:'POST',body:JSON.stringify({name:$('member-name').value,username:$('member-username').value,email:$('member-email').value})}); $('user-dialog').close(); showCredentials(result.user,result.password); await loadUsers(); } catch(error) { $('user-error').textContent=error.message; } finally { $('user-submit').disabled=false; } };
$('confirm-user-action').onclick = async () => { if (!pendingUserAction) return; $('confirm-user-action').disabled=true; try { const {user,type}=pendingUserAction; const result=await api(`/users/${user.id}${type === 'reset' ? '/reset' : ''}`,{method:'POST',body:JSON.stringify({active:user.state !== 'active'})}); $('user-action-dialog').close(); pendingUserAction=null; if (result.password) showCredentials(result.user,result.password); else toast('Kullanıcı erişimi güncellendi.'); await loadUsers(); } catch(error) { toast(error.message); } finally { $('confirm-user-action').disabled=false; } };
$('credential-dialog').addEventListener('close',()=>{ $('credential-value').value=''; });
$('copy-credentials').onclick=async()=>{ try { await navigator.clipboard.writeText($('credential-value').value); toast('Giriş bilgileri kopyalandı. Yalnızca ilgili kullanıcıyla paylaşın.'); } catch { toast('Bilgileri seçip manuel olarak kopyalayın.'); } };
window.addEventListener('beforeunload',event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange',() => { if (!busy) receive().then(found => { if (!found) show('send'); }); });
(async () => {
  if (staticSetup) {
    config = {configured:false,loggedIn:false};
    $('setup-notice').hidden=false;
    $('setup-notice').textContent='Dosya paylaşım hizmeti hazırlık aşamasında. Güvenli bağlantı tamamlanana kadar dosya gönderimi kapalıdır.';
    for (const id of ['account','history-nav','users-nav']) $(id).hidden=true;
    for (const input of $('transfer-form').querySelectorAll('input,textarea,select,button')) input.disabled=true;
    $('dropzone').tabIndex=-1; $('dropzone').setAttribute('aria-disabled','true');
    $('send-button').textContent='Yakında kullanıma açılacak';
    return;
  }
  try { config = await api('/status'); $('demo-banner').hidden = !config.demo; $('setup-notice').hidden = config.configured; accountLabel(); await receive(); } catch { toast('Sunucuya bağlanılamıyor. Sayfayı yenileyip tekrar deneyin.'); } })();
