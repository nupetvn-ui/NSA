# Viết plugin đầu tiên cho NSA

Plugin là một thư mục có `nsa-plugin.json` và một file JavaScript (ESM). Ví dụ đầy đủ chạy được: [`plugins/ghi-chu-nhanh`](../plugins/ghi-chu-nhanh). Cách cô lập và giới hạn: [ADR-0010](adr/0010-app-store-plugin-host-va-cong-mcp.md).

## 1. Thư mục

```
hello/
  nsa-plugin.json
  main.js          # chạy trong tiến trình riêng
  ui/index.html    # màn hình (tuỳ chọn)
```

## 2. Manifest

```json
{
  "id": "hello",
  "name": "Xin chào",
  "icon": "emoji:👋",
  "version": "1.0.0",
  "nsa": ">=0.1.0",
  "main": "main.js",
  "tools": [
    {
      "name": "greet",
      "description": "Chào một người theo tên.",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      }
    }
  ],
  "screens": [{ "id": "main", "title": "Xin chào", "entry": "ui/index.html" }]
}
```

- `permissions` (tuỳ chọn): `network` (tên miền), `folders` (`{ id, label, access }`), `memory: true` (kèm `"memory": { "branch": "…", "title": "…" }`), `notifications: true`. Không xin thì không có.
- Tool `sensitive: true` (xoá, gửi hàng loạt…): NSA luôn hỏi người dùng trước mỗi lần chạy.
- `jobs`: `{ "id": "tick", "title": "…", "every": "30s" }` (tối thiểu 10 giây).
- Kiểm manifest: `pnpm --filter @nsa/plugin-host build` rồi `node packages/plugin-host/dist/cli.js validate hello`. Lỗi được báo bằng tiếng Việt kèm vị trí.

## 3. Mã

```js
/** @type {import('@nsa/plugin-sdk').PluginDefinition} */
export default {
  activate(ctx) {
    ctx.log('đã bật');
  },
  tools: {
    greet: (args, ctx) => `Xin chào ${args.name}! (gọi bởi ${ctx.caller.agentId})`,
  },
  jobs: {},
  ui: { ping: () => 'pong' }, // màn hình gọi: await nsa.call('ping')
};
```

`ctx` có: `dataDir` (thư mục dữ liệu riêng, dùng `node:fs` thoải mái), `folder(id)`, `config.get/set/all`, `memory.search/read/propose` (khi được cấp quyền; chỉ trong nhánh của plugin, `propose` đi qua hộp duyệt), `notify`, `fetch` (= `fetch` toàn cục, chỉ tới tên miền được cấp), `emit(sự kiện, dữ liệu)` → màn hình, `log`.

Plugin **không** đọc được thứ ngoài quyền: file ngoài thư mục của nó và thư mục được cấp, mạng ngoài tên miền được cấp, key API, dữ liệu plugin khác, tiến trình con. Không có `node_modules` kèm theo: gộp phụ thuộc thành một file (esbuild, rollup…) trước khi đóng gói.

## 4. Màn hình

HTML thường, chạy trong khung cô lập (không có API Electron). Chỉ có `window.nsa`:

```html
<script>
  nsa.call('ping').then((r) => (document.body.textContent = r));
  nsa.on('tick', (data) => console.log(data)); // plugin gọi ctx.emit('tick', …)
</script>
```

Không gọi được mạng từ màn hình — để plugin (`main.js`) làm rồi trả kết quả.

## 5. Thử và đóng gói

- Chế độ nhà phát triển: NSA → App Store → Quản lý → bật **Chế độ nhà phát triển** → **Cài từ thư mục…** → xem quyền → Cài. Không cần khởi động lại app; sửa mã thì Gỡ rồi cài lại.
- Đóng gói có chữ ký:

```bash
node packages/plugin-host/dist/cli.js keygen khoa-cua-toi.json
```

```bash
node packages/plugin-host/dist/cli.js pack hello --key khoa-cua-toi.json --publisher "Tên bạn"
```

Gói `.nsapkg` sẽ được NSA từ chối nếu bị sửa sau khi ký. Người dùng muốn tin nhà phát hành của bạn thì thêm khoá công khai vào `%APPDATA%\NSA\plugins\trusted-publishers.json` (`[{ "keyId", "name", "publicKey" }]`).

## 6. Kho

Chỉ mục kho là một file JSON: `{ "plugins": [{ "id", "name", "description", "version", "icon", "nsa", "package", "sha256" }] }`; nhập đường dẫn hoặc URL của nó ở App Store → Quản lý → Kho.
