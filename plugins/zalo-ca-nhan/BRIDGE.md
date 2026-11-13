# Cầu nối Zalo cá nhân (KHÔNG chính thức)

> **Cảnh báo.** Zalo không có API chính thức cho tài khoản cá nhân. Dùng chương trình tự động trên nick cá nhân vi phạm điều khoản của Zalo và có thể khiến nick bị khoá hoặc cấm vĩnh viễn. Đừng dùng nick chính hay nick quan trọng. NSA không chịu trách nhiệm về tài khoản. Doanh nghiệp nên dùng plugin **Zalo OA** (chính thức).

Plugin `zalo-ca-nhan` **không chứa mã đăng nhập hay giao thức Zalo**. Nó nói chuyện với một "cầu nối" chạy trên máy bạn tại `http://localhost:<cổng>` (cấu hình ở tab Cài đặt của màn hình plugin). NSA **không đi kèm** cầu nối nào và chưa kiểm cầu nối nào — xem [ADR-0011](../../docs/adr/0011-kenh-chat-plugin-khe-bi-mat-va-canh-nhom-theo-lo.md).

Mọi lời gọi có header `Authorization: Bearer <mã bí mật>`; mã này bạn đặt cho cầu nối và dán ở **Quản lý → Zalo cá nhân → Bí mật** (plugin không đọc được giá trị). Cầu nối chỉ nên nghe trên `127.0.0.1`.

| Gọi                                        | Trả về                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /me`                                  | `{ "id": "…", "name": "…" }` — tài khoản (nick) đang đăng nhập                                                                                                                                                           |
| `GET /messages?after=<con trỏ>`            | `{ "messages": [ { "id", "chatId", "chatName", "chatKind": "group"\|"private", "fromId", "fromName", "text", "at": "ISO", "mentionsMe": true\|false } ], "cursor": "…" }` — tin mới từ lần trước; `after` rỗng ở lần đầu |
| `POST /send` `{ chatId, text }`            | `{ "ok": true }`                                                                                                                                                                                                         |
| `POST /delete` `{ chatId, messageId }`     | `{ "ok": true }`                                                                                                                                                                                                         |
| `POST /remove-member` `{ chatId, userId }` | `{ "ok": true }`                                                                                                                                                                                                         |
| `POST /change-owner` `{ chatId, userId }`  | `{ "ok": true }`                                                                                                                                                                                                         |

Lỗi: HTTP ≠ 2xx hoặc `{ "error": "mô tả" }`. Các thao tác `delete`, `remove-member`, `change-owner` luôn được NSA hỏi bạn trước (tool nhạy cảm).

Người viết cầu nối chịu trách nhiệm chọn thư viện (cần kiểm nguồn và giấy phép) và giữ phiên đăng nhập Zalo ở ngoài NSA.
