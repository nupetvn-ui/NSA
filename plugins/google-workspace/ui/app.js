// Màn hình Google Workspace. Chỉ dùng window.nsa; chữ hiển thị đều qua textContent.
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  function el(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  var TOOLS = [
    'Đọc: Drive (liệt kê, xem file), Gmail (tóm tắt thư chưa đọc, đọc thư), Calendar (lịch sắp tới), Sheets (đọc ô), Docs (đọc tài liệu).',
    'Ghi (không hỏi): thêm một hàng vào Sheets, thêm văn bản vào cuối Docs.',
    'LUÔN HỎI BẠN TRƯỚC: gửi Gmail, gửi tin Google Chat, xoá file Drive.',
  ];
  function draw(status) {
    var conn = $('conn');
    var b = $('banners');
    b.textContent = '';
    if (!status.granted) {
      conn.textContent = 'Chưa cấp quyền chạy gws';
      conn.className = 'pill bad';
      b.appendChild(
        el('div', {
          class: 'banner err',
          text: 'Plugin chưa được cấp quyền chạy chương trình gws. Mở App Store → Quản lý → Google Workspace và bật quyền.',
        }),
      );
    } else if (!status.installed) {
      conn.textContent = 'Chưa có gws';
      conn.className = 'pill bad';
      b.appendChild(
        el('div', { class: 'banner err' }, [
          el('strong', { text: 'Chưa dùng được gws. ' }),
          status.error || '',
          el('ol', {}, [
            el('li', {
              text: 'Tải bản Windows (.zip) ở github.com/googleworkspace/cli/releases, giải nén gws.exe vào một thư mục có trong PATH.',
            }),
            el('li', {
              text: 'Mở terminal, chạy: gws auth setup (cần gcloud) hoặc làm theo "Manual OAuth setup" trong README của gws.',
            }),
            el('li', {
              text: 'Chạy: gws auth login (chọn dịch vụ cần dùng, ví dụ: gws auth login -s drive,gmail,calendar,sheets,docs,chat).',
            }),
          ]),
        ]),
      );
    } else {
      conn.textContent = 'gws đã cài: ' + status.version;
      conn.className = 'pill ok';
    }
    b.appendChild(
      el('div', {
        class: 'banner warn',
        text: '⚠ gws không phải sản phẩm chính thức của Google. Nội dung thư / tài liệu do người khác viết có thể dụ agent làm điều có hại; vì vậy gửi thư, gửi Chat và xoá file luôn hỏi bạn. Plugin chưa chạy thử với tài khoản Google thật.',
      }),
    );
  }
  function drawLog(items) {
    var box = $('log');
    box.textContent = '';
    if (!items.length) box.appendChild(el('div', { class: 'muted', text: 'Chưa có lần gọi nào.' }));
    items.forEach(function (e) {
      box.appendChild(
        el('div', { class: 'card' }, [
          el('span', { class: 'muted', text: new Date(e.at).toLocaleString('vi-VN') + ' · ' }),
          el('strong', { text: e.tool }),
          el('span', {
            class: e.ok ? 'muted' : 'bad',
            text: ' — ' + (e.ok ? 'xong' : 'lỗi: ' + e.detail),
          }),
        ]),
      );
    });
  }
  function load() {
    nsa.call('status').then(draw, function (e) {
      $('conn').textContent = String(e.message || e);
    });
    nsa.call('log').then(drawLog, function () {});
  }
  var tools = $('tools');
  TOOLS.forEach(function (t) {
    tools.appendChild(el('div', { text: t }));
  });
  $('refresh').addEventListener('click', load);
  $('clear').addEventListener('click', function () {
    nsa.call('clearLog').then(load);
  });
  load();
})();
