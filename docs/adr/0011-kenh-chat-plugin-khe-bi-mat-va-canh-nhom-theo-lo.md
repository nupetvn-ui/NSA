# ADR-0011: Kênh chat — token không tới plugin, cổng hành động, canh nhóm theo lô, Zalo

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13
- Bổ sung cho [ADR-0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md), [ADR-0008](0008-nsa-mem.md), [ADR-0009](0009-nguon-model-qua-api-key.md), [ADR-0010](0010-app-store-plugin-host-va-cong-mcp.md)

## Bối cảnh

Giai đoạn 4 của [PLAN.md](../PLAN.md): Telegram, Discord, Zalo; nhớ theo nhóm / nick; canh nhóm theo lô; "bot trả lời đúng nội quy từng nhóm". Mỗi kênh là một plugin trong `plugins/` (`telegram`, `discord`, `zalo-oa`, `zalo-ca-nhan`). Plugin chạy theo ADR-0010: tiến trình riêng, mạng chỉ qua `fetch` do lõi kiểm.

Ba việc ADR-0010 chưa làm được cho kênh chat, nên phải **sửa lõi** (lý do ở từng mục):

1. Token bot phải đến được máy chủ Telegram / Discord mà plugin không được cầm nó.
2. Việc gửi tin / xoá / cấm là hành động ra ngoài, phải đi qua `Policy` + `AuditLog` ngay cả khi chạy nền (không có lượt chat nào để hỏi).
3. Plugin cần gọi model "kênh chat" (ADR-0009) mà không có key.

## Quyết định

### 1. Khe bí mật: plugin không bao giờ đọc được token

Manifest khai `secrets: [{ id, label, help, hosts, where }]`. Người dùng nhập giá trị ở **Quản lý → Bí mật** — ô nhập do NSA vẽ, không nằm trong màn hình của plugin (màn hình plugin là mã của plugin). Giá trị đi thẳng vào kho khoá hệ điều hành (`plugin-secrets.json`, mã hoá bằng `safeStorage` / DPAPI như key API, tên khoá `plugin:<id>:<khe>`), tách khỏi key API. Không có API nào cho plugin đọc: `ctx.secrets.has(id)` chỉ trả đã nhập chưa.

Plugin viết `{{secret:bot_token}}` trong `fetch`; **lõi** thay giá trị thật, với các ràng buộc (có test, `packages/plugin-host/src/channel.test.ts`):

- Tên miền đích phải nằm trong `hosts` của khe (kiểm lại ở mỗi bước chuyển hướng) và trong quyền `network`. Khe dùng cho tên miền khác bị từ chối + ghi nhật ký, dù plugin được cấp mạng tới tên miền đó.
- `where` quy định chỗ đặt: mặc định chỉ **đường dẫn URL** (không phải query) và **header**; **body bị cấm** trừ khi khe khai rõ. Lý do: ngăn plugin đăng token vào nội dung tin nhắn (`sendMessage?text=…` hay body JSON). Telegram đặt token trong đường dẫn, Discord trong header `Authorization`.
- Placeholder không được nằm ở phần tên miền; khe chưa khai báo hoặc chưa nhập → lỗi rõ ràng, không gọi mạng.
- **Phản hồi bị che**: mọi giá trị bí mật (dạng thô, URL-encode, base64, JSON) còn sót trong phản hồi / header phản hồi bị thay bằng `«bí mật»` trước khi tới plugin.
- **Xoay vòng token** (Zalo OA làm mới access token): header `x-nsa-capture: khe=truong.json` làm lõi lưu giá trị đó từ phản hồi vào đúng khe (chỉ khi phản hồi đến từ tên miền của khe) và thay bằng dấu che trong phản hồi.
- Gỡ plugin xoá luôn bí mật của nó.

Nội dung gửi model và tóm tắt trong nhật ký cũng được che giá trị bí mật của plugin + mọi key API của app.

### 2. Cổng hành động `plugin.action`

`PolicyAction` có thêm `plugin.action { pluginId, action, sensitive, target, summary }`; `AuditEntry` plugin có thêm `action`, `secret`, `model`.

- `ctx.gate({ action, sensitive, target, summary, tool })`: Policy → (hỏi người dùng nếu chính sách trả "hỏi") → AuditLog. Bị chặn / từ chối thì ném lỗi; mã kênh làm đúng thế: **không gọi API gửi nếu gate ném lỗi**.
- **Không dựa vào việc plugin tự gọi gate**: mọi lời gọi `fetch` **ghi** (POST / PUT / DELETE…) có dùng bí mật của plugin cũng tự đi qua `plugin.action` (`http.post` → máy chủ). Plugin viết thiếu / cố lách vẫn không gửi được khi chính sách chặn (có test).
- `sensitive: true` (đổi trưởng nhóm, xoá tin, mời ra, gửi hàng loạt, bật chế độ trả lời): bản Cá nhân **luôn hỏi**. Hỏi bằng hộp thoại hệ điều hành (`dialog.showMessageBox`, 25 giây không trả lời = từ chối), vì việc nền không có lượt chat để hỏi. Khi agent gọi tool nhạy cảm qua cổng MCP thì cổng đã hỏi rồi; host nhớ lời gọi đang chạy theo tên tool để không hỏi lần hai (tool không nhạy cảm khai gian tên thì vẫn bị hỏi — có test).
- Bản Doanh nghiệp đổi chính sách thì chặn / yêu cầu duyệt được mà không sửa plugin.

### 3. Model cho plugin: quyền `model`

Quyền mới `permissions.model` (hộp xin quyền nói rõ nội dung tin nhắn đi tới nhà cung cấp model người dùng chọn). `ctx.model.complete(prompt, { system })` → `ModelTaskRunner.runText('channel', …)` đã có từ ADR-0009: chọn model rẻ cho việc `channel`, `model.use` qua Policy, theo dõi chi phí, chuyển model dự phòng. Plugin không biết hãng nào và không có key. Nhật ký chỉ ghi số ký tự, không ghi nội dung.

Chưa làm: **vòng lặp gọi tool** của bot qua cổng MCP. Adapter `api` vẫn chưa có vòng lặp (ADR-0010) nên bot trả lời bằng văn bản; agent thật (Claude Code, Codex, OpenCode) gọi tool của kênh qua cổng như mọi plugin.

### 4. Bản đóng gói và cảnh báo rủi ro

Manifest có `editions` (`["personal"]`) và `warning`. Plugin không hợp bản đang chạy thì `blocked` ở bước chuẩn bị và `denied` ở bước cài. Plugin có `warning` thì hộp cài hiện cảnh báo trên đầu và **bắt buộc xác nhận riêng** ("Tôi hiểu, vẫn cài") — kể cả với gói ký tin cậy. Zalo cá nhân dùng cả hai.

### 5. Nhớ theo nhóm / nick

Nhánh nhớ của plugin (ADR-0010) có nhánh con, tối đa 3 cấp, chữ thường / số / `-` / `_`; plugin chọn bằng `subBranch` của `memory.search / list / propose`, host gắn vào `plugin/<id>/<nhánh>/<sub>` (không thoát khỏi nhánh plugin — có test `..`, `/`, 4 cấp):

```
plugin/<kênh>/<nhánh>/quy-tac-chung
plugin/<kênh>/<nhánh>/theo-nhom/<mã nhóm>
plugin/<kênh>/<nhánh>/theo-nick/<mã nick>
```

Nội quy là mục nhớ `kind: rule`, đề xuất từ màn hình plugin → **Hộp duyệt** như mọi nguồn (quy tắc hành vi luôn chờ người duyệt). Chủ ý: người lạ trong nhóm không thể dạy bot, và bot chỉ theo nội quy sau khi chủ tài khoản duyệt. Lời nhắc của một nhóm chỉ chứa nội quy chung + của nhóm đó + của nick (có test: nội quy nhóm A không vào lời nhắc nhóm B).

### 6. Canh nhóm theo lô (bộ khung `plugins/_kit/channel-kit.js`)

Mỗi plugin chỉ viết adapter (`me / poll / send / deleteMessage / removeMember`); phần chung (trạng thái, lô, nội quy, model, gate, tool, màn hình) ở `_kit`, chép vào từng plugin thành `kit.js` + `ui/` bằng `node plugins/sync-kit.mjs` (plugin phải tự đủ trong thư mục của nó; test kiểm bản sao không lệch).

- Việc nền `tick` mỗi 10 giây: đọc tin mới → xếp vào hàng đợi theo nhóm → nhóm "tới hạn" thì xử lý. Tới hạn khi đủ `batchMax` tin (25), hoặc tin cũ nhất ≥ `batchSeconds` (90 giây), hoặc có tin gọi thẳng bot (nhắc tên / nhắn riêng) chờ ≥ 5 giây. **Mỗi nhóm mỗi lượt đúng một lần gọi model cho cả lô** — test: 50 tin ở 2 nhóm = 2 lần gọi. Trần 20 lần / nhóm / giờ và 120 lần / giờ toàn plugin (chỉnh được).
- Ba chế độ mỗi nhóm: **Tắt** (mặc định cho nhóm mới: không lưu tin, không gọi model, không gửi), **Canh** (gọi model, ghi vi phạm và điều bot _sẽ_ nói, không gửi), **Trả lời** (gửi qua gate). Bot không bao giờ tự cấm / xoá / mời ra: vi phạm chỉ được ghi nhận và báo; xoá / cấm là tool `sensitive` luôn hỏi.
- Tin nhắn là **dữ liệu không đáng tin**: nằm trong khối JSON, lời nhắc hệ thống dặn không làm theo chỉ dẫn trong đó; đầu ra bắt buộc JSON và được làm sạch (vô hiệu `@everyone` / `@here`, bỏ câu giống token, cắt độ dài, tối đa 3 câu trả lời / lô). Đây là giảm thiểu chứ không phải bảo đảm: model vẫn có thể bị dắt mũi nói điều không nên nói trong phạm vi nội quy.
- Màn hình (cùng một mã cho mọi kênh): cấu hình / trạng thái kết nối, danh sách nhóm + chế độ, nội quy từng nhóm (+ chung, + nick) và nút "Bot sẽ nói gì?" chạy thử không gửi, tin gần đây, nhật ký, cài đặt lô.

### 7. Các kênh

| Plugin         | Cách nối                                                                                                                                                                  | Ghi chú                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `telegram`     | Bot API chính thức, `getUpdates` đọc theo lịch (không webhook)                                                                                                            | Cần tắt chế độ riêng tư của bot (BotFather `/setprivacy`) để đọc mọi tin trong nhóm                                   |
| `discord`      | REST chính thức: khám phá kênh chữ, đọc `GET /channels/{id}/messages?after=` cho kênh đang bật                                                                            | Không dùng WebSocket Gateway (runner chặn WebSocket). Cần "Message Content Intent". Chưa đọc được tin nhắn riêng (DM) |
| `zalo-oa`      | OpenAPI chính thức của Zalo OA, đọc `listrecentchat` theo lịch, gửi `message/cs`; token tự làm mới                                                                        | Mỗi khách là một hội thoại "riêng"; mặc định Tắt, người dùng có thể đặt mặc định khác                                 |
| `zalo-ca-nhan` | **Không chính thức**. Nói chuyện với một "cầu nối" chạy trên máy (`localhost`) theo hợp đồng trong [plugins/zalo-ca-nhan/BRIDGE.md](../../plugins/zalo-ca-nhan/BRIDGE.md) | `editions: ["personal"]` + cảnh báo khoá nick phải xác nhận riêng. Có tool đổi trưởng nhóm (nhạy cảm)                 |

**Vì sao Zalo cá nhân là "cầu nối" chứ không có sẵn mã đăng nhập Zalo**: các thư viện không chính thức cho Zalo cá nhân cần WebSocket / socket thô, mà runner của plugin chặn cả hai (ADR-0010); viết lại giao thức Zalo mà không có nick để thử là đoán mò; và NSA không được đi kèm một thư viện chưa kiểm nguồn. Cầu nối là chương trình tách rời do người dùng chọn và tự chịu rủi ro; NSA chỉ định nghĩa hợp đồng. **Chưa có cầu nối nào được chọn / kiểm** — cần quyết định của người dùng (xem "Chưa chạy thật").

## Logo hãng (biểu tượng plugin kênh, agent và nhà cung cấp)

Yêu cầu của người dùng: dùng logo chính thức của hãng, không tự vẽ lại gần giống. File là **bản gốc, không sửa** (không đổi màu / cắt / kéo giãn). Người dùng cho phép tải về dùng trong NSA ("không cần giấy phép"); điều khoản từng hãng ghi lại dưới đây — **chưa có luật sư xem**, và NSA bán thương mại nên cần soát lại trước khi phát hành (giai đoạn 8).

| Hãng               | Nguồn (ngày tải 2026-11-13)                                                                                         | Điều khoản nêu trên trang nguồn                                                                                                                                                                                                                                     | Dùng ở                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Telegram           | [telegram.org/tour/screenshots](https://telegram.org/tour/screenshots) → "Download Telegram Logos" (`Logo.svg`)     | "Please feel free to use these Telegram logos for article illustrations, graphs, 'forward to Telegram' buttons, etc. Just make sure people understand you're not representing Telegram officially." Liên hệ báo chí `@PressBot`. CC0 chỉ ghi cho ảnh chụp màn hình. | `plugins/telegram/icon.svg`               |
| Discord            | [discord.com/branding](https://discord.com/branding) → Symbol (Blurple)                                             | Cho dùng logo màu / đen / trắng; symbol "only when the Discord brand is clearly visible or has been well established elsewhere"; không sửa / đổi màu. Trang cũng ghi cần phép của Discord cho cách dùng ngoài hướng dẫn (Legal Brand Guidelines, chưa đọc hết).     | `plugins/discord/icon.svg`                |
| Zalo               | **Không có brand kit công khai**. Dùng `logo.svg` (chữ "Zalo", #0068FF) lấy từ trang chủ [zalo.me](https://zalo.me) | **Không tìm thấy điều khoản nào.** Nên xin VNG (hoặc dùng bộ nhận diện Zalo chính thức nếu có) trước khi bán.                                                                                                                                                       | `plugins/zalo-oa`, `plugins/zalo-ca-nhan` |
| Anthropic / Claude | [anthropic.com/press-kit](https://www.anthropic.com/press-kit) (`Claude Spark - Clay.svg`)                          | Theo [Trademark Guidelines](https://www.anthropic.com/legal/trademark-guidelines) của Anthropic (chưa đọc hết). Dùng cho Claude Code và nhà cung cấp Anthropic.                                                                                                     | `apps/desktop/src/renderer/src/brand/`    |
| OpenRouter         | [openrouter.ai/brand](https://openrouter.ai/brand) (`glyph-grape.svg`)                                              | "Please don't stretch, recolor, or remix the marks."                                                                                                                                                                                                                | cùng thư mục                              |
| Together AI        | [together.ai/brand](https://www.together.ai/brand) → "Together AI Logo Suite" (`TogetherAI_Favicon.svg`)            | Trang ghi là brand guidelines chính thức; chưa đọc hết điều khoản.                                                                                                                                                                                                  | cùng thư mục                              |
| LM Studio          | [lmstudio.ai/brand](https://lmstudio.ai/brand) (`lm-studio-icon-color.svg`)                                         | "By downloading our assets, you agree to our usage terms" (liên kết trên trang; chưa đọc hết). Không tách biểu tượng khỏi chữ khi dùng theo hướng dẫn.                                                                                                              | cùng thư mục                              |
| Kimi (Moonshot)    | [kimi.ai/resources/kimi-brand](https://www.kimi.ai/resources/kimi-brand) → Logomark (Dark / Light)                  | Brand Book của Kimi (chưa đọc hết).                                                                                                                                                                                                                                 | cùng thư mục                              |

**Hãng không có brand kit công khai dùng được** — theo quyết định của người dùng ("lấy từ trang chủ"), dùng biểu tượng lấy từ chính trang web của hãng (2026-11-13), **không có điều khoản công bố**, rủi ro nhãn hiệu cao hơn các hãng ở bảng trên: OpenAI / ChatGPT / Codex (bộ logo đầy đủ nằm sau đăng nhập `brand.openai.com`, bản tải công khai chỉ có mẫu Photoshop; dùng `openai.com/favicon.svg`), Google / Gemini / Gemini CLI (`gstatic.com`, biểu tượng sao Gemini; Partner Marketing Hub không có đường tải trực tiếp), xAI (`x.ai/favicon.ico`; trang grok.com chặn tải tự động), DeepSeek, Qwen, GLM (Z.ai), MiniMax, Groq, Fireworks, Ollama, OpenCode. Danh sách file và nguồn: `apps/desktop/src/renderer/src/brand/README.md`. Antigravity chưa có logo riêng (hiện ô chữ cái). Trước khi bán NSA nên xin phép các hãng này hoặc thay bằng bản có điều khoản rõ.

## Kết quả kiểm (2026-11-13)

**Test tự động** (`pnpm test`): `packages/plugin-host/src/channel.test.ts` (khe bí mật, cổng hành động, model, nhánh nhớ con, bản đóng gói / cảnh báo) và `plugins/channels.test.ts` (bộ khung + cả bốn plugin chạy trong plugin host thật, tiến trình riêng `node --permission`, NSA Mem thật, cổng MCP thật; máy chủ Telegram / Discord / Zalo / cầu nối là máy chủ giả trên localhost). Gồm các điều "Xong khi" đòi hỏi:

- Bot trả lời đúng nội quy từng nhóm: nội quy qua Hộp duyệt → chỉ nội quy của nhóm đó + chung + nick vào lời nhắc; nhóm Tắt không lưu / không gọi model.
- Chính sách chặn thì bot không gửi: cả qua `gate` lẫn khi plugin tự gọi thẳng API bằng token.
- Plugin không đọc được thứ ngoài quyền (token, biến môi trường, tên miền khác, thư mục ngoài — kế thừa test cô lập của ADR-0010).
- **Quét chuỗi token**: sau khi chạy cả luồng, không thấy token trong nhật ký (`AuditLog`), thư mục NSA Mem, nội dung gửi model, thư mục dữ liệu / trạng thái / cấu hình của plugin, `PluginInfo` gửi lên giao diện (kể cả dạng URL-encode / base64 / JSON ở phần che).

**Chạy thật trong app** (Electron, `pnpm dev` và bản đóng gói `win-unpacked`, thư mục dữ liệu riêng, qua CDP): cài plugin Telegram → nhập token bằng ô thật ở Quản lý → token vào `plugin-secrets.json` mã hoá (quét: không có bản rõ) → bot kết nối → nhóm mới Tắt → bật Trả lời / Canh → nội quy vào Hộp duyệt → duyệt → mỗi nhóm đúng một lần gọi model, đúng nội quy, nhóm Canh không gửi, nhóm Trả lời gọi `sendMessage` có token do lõi điền; dòng nhật ký `action` không chứa token. Máy chủ Telegram và model là **máy chủ giả** trên máy; key model là chuỗi giả.

## Chưa chạy thật (trung thực)

- **Telegram, Discord, Zalo OA**: chưa thử với token / tài khoản thật. Mã viết theo tài liệu API; chỉ chạy với máy chủ giả. Có thể sai ở chi tiết định dạng thật.
- **Zalo OA**: endpoint làm mới token (`oauth.zaloapp.com/v4/oa/access_token`) đã đối chiếu tài liệu; endpoint đọc (`/v2.0/oa/listrecentchat`, `/v2.0/oa/getoa`) và gửi (`/v3.0/oa/message/cs`) viết theo trí nhớ về tài liệu, chưa đối chiếu được — cần thử với một OA thật. Webhook không dùng được ở bản máy bàn (cần địa chỉ công khai) nên đọc theo lịch; OA chỉ trả lời được khách trong khung thời gian chính sách Zalo cho phép.
- **Zalo cá nhân**: chưa có cầu nối thật và chưa thử với nick Zalo nào; chỉ chạy với cầu nối giả. Cần người dùng quyết định dùng thư viện không chính thức nào (ứng viên hay gặp: `zca-js`, **chưa được kiểm**) và chấp nhận rủi ro khoá nick.
- Hộp thoại hỏi thao tác nhạy cảm khi plugin chạy nền (`dialog.showMessageBox`): logic có test (callback giả), **chưa bấm thử hộp thoại thật**. Đường tool nhạy cảm qua cổng MCP với Claude Code / OpenCode thật cũng chưa thử cho các plugin kênh (đã thử với `ghi-chu-nhanh` ở ADR-0010).
- Chưa thử lâu dài (nhiều nhóm, tin dồn dập, mạng chập chờn, Telegram `409` khi đang có webhook, Discord `429` thật).
- Chưa có vòng lặp gọi tool cho bot (mục 3).

## Giới hạn

- Giới hạn cô lập của ADR-0010 vẫn đúng. Khe bí mật chặn plugin _đọc_ token, không chặn plugin _dùng_ nó vào đúng tên miền đã gắn: plugin độc hại có `network` + khe Telegram vẫn gọi được API Telegram bằng bot của bạn (gửi / xoá) — chặn bằng `plugin.action` cho lời gọi ghi + hộp hỏi cho thao tác nhạy cảm, không bằng mật mã. Kho công khai (giai đoạn 8) cần chữ ký + kiểm duyệt.
- Chính sách Cá nhân mặc định **cho phép** gửi không nhạy cảm (đó là việc của bot); ai muốn hỏi từng lần thì dùng chế độ Canh hoặc chính sách chặt hơn.
- Nội dung nhóm chat đi tới nhà cung cấp model (đã nói rõ ở hộp xin quyền). Nhóm nhạy cảm → để Tắt hoặc chọn model chạy trên máy (Ollama / LM Studio) cho việc "kênh chat".
- Tin của nhóm đang bật lưu trên máy ở thư mục dữ liệu của plugin (`state.json`, tối đa 150 tin gần nhất cho màn hình + hàng đợi); gỡ plugin xoá cùng dữ liệu. Mục nhớ (nội quy) được giữ lại như mọi plugin.

## Hệ quả

- Lõi thay đổi: manifest (`secrets`, `editions`, `warning`, quyền `model`), `PluginHost` (khe bí mật, `gate`, `model.complete`, `memory.list` + `subBranch`), `PolicyAction` / `AuditEntry` / IPC (`plugins:setSecret`, `plugins:deleteSecret`), giao diện Quản lý (ô bí mật, quyền model, cảnh báo rủi ro). Plugin cũ (`ghi-chu-nhanh`) chạy nguyên (bản ghi quyền cũ được bổ sung `model: false`).
- Plugin kênh mới viết sau này chỉ cần adapter + manifest (+ bản sao `_kit`).
