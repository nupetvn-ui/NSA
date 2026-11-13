// Màn hình chạy trong khung cô lập: chỉ có `window.nsa` (call / on), không có API của Electron.
const list = document.getElementById('list');
const msg = document.getElementById('msg');
const stats = document.getElementById('stats');
const input = document.getElementById('text');

function say(text) {
  msg.textContent = text || '';
}

async function refresh() {
  const notes = await nsa.call('list');
  list.textContent = '';
  if (notes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent =
      'Chưa có ghi chú nào. Agent cũng có thể thêm ghi chú qua tool ghi_chu_nhanh__add_note.';
    list.append(empty);
  }
  for (const note of notes) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `#${note.id} ${note.text}`;
    const pin = document.createElement('button');
    pin.className = 'ghost';
    pin.textContent = 'Ghim vào bộ nhớ';
    pin.onclick = async () => {
      try {
        const r = await nsa.call('pin', { id: note.id });
        say(r.status === 'accepted' ? 'Đã ghim vào bộ nhớ.' : 'Đã đưa vào hộp duyệt của bộ nhớ.');
      } catch (e) {
        say(e.message);
      }
    };
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Xoá';
    del.onclick = async () => {
      await nsa.call('remove', { id: note.id });
      await refresh();
    };
    li.append(text, pin, del);
    list.append(li);
  }
}

function showStats(s) {
  if (s) {
    stats.textContent = `Việc nền: ${s.count} ghi chú · cập nhật lúc ${new Date(s.checkedAt).toLocaleTimeString()}`;
  }
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  try {
    await nsa.call('add', { text });
    input.value = '';
    say('');
    await refresh();
  } catch (err) {
    say(err.message);
  }
});

nsa.on('stats', (s) => {
  showStats(s);
  void refresh(); // agent có thể vừa thêm ghi chú
});
void refresh();
void nsa.call('stats').then(showStats);
