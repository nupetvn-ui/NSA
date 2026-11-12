; Bổ sung cho bộ cài NSIS của electron-builder (xem docs/adr/0003 và README).
;
; Sau khi cập nhật im lặng (--updated /S --force-run), bộ cài mặc định mở lại app qua lối tắt
; Start Menu vừa tạo lại. Thử thật trên Windows 10: Explorer báo "Windows cannot find ...\NSA.lnk"
; và app không tự mở lại. Mở thẳng file NSA.exe thì không phụ thuộc vào lối tắt.
; Macro customInstall chạy ngay trước bước mở lại app (installSection.nsh).
!macro customInstall
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
