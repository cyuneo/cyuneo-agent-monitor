# CYUNEO Agent Monitor

[English](README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [한국어](README.ko.md) · [日本語](README.ja.md)

在一個地方看到你所有的 AI 程式設計聊天視窗，就在終端機旁邊：哪些智慧體正在執行、哪些需要你處理，以及每個上下文用了多少。支援 Claude Code、Codex 和 GitHub Copilot Chat，Gemini CLI 和 Qwen Code 目前是預覽。

[**在 VS Code 中安裝**](https://vscode.dev/redirect?url=vscode:extension/cyuneo.cyuneo-agent-monitor) · [在 VS Code Marketplace 查看](https://marketplace.visualstudio.com/items?itemName=cyuneo.cyuneo-agent-monitor)

> **預覽版（0.5.0）。** 如果發現任何不對勁的地方，歡迎到 [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues) 回報。

![Agent Monitor 在 VS Code 面板中的動態示範，資料是虛構的範例：一個 Claude Code 聊天視窗裡，主智慧體和兩個子智慧體依序讀取檔案、搜尋、編輯、執行測試，token、費用和上下文百分比隨之上升。其中一個子智慧體要執行測試、等你核准時亮起洋紅色燈，清單裡這個聊天的燈和面板分頁上的計數也跟著改變。核准後繼續，所有智慧體完成，亮起綠燈。最後在清單裡點選一個 Codex 聊天，面板換成它的步驟](images/demo.gif)

## 為什麼做這個

Claude Code 和 Codex 現在會同時跑好幾個智慧體：子智慧體、背景智慧體、整條工作流程。可是在 VS Code 裡，這些工作大多看不見：

- **看不到誰在做什麼。** 智慧體檢視要點開才會出現，一個在等你核准的智慧體可能就這樣乾等著，沒人發現。
- **上下文悄悄變滿。** 往往是自動壓縮在不適當的時候突然觸發，或長對話開始忘東忘西，你才察覺。
- **離開一下，快取就過期了。** 一小時後回來，下一則訊息要按全價把整個上下文重新讀一遍。
- **碰到額度上限，工作停在半路。** 智慧體停了，你得自己發現、等額度重置，再手動讓它們繼續。

## 它能幫你做什麼

- **一眼看完所有聊天。** 終端機旁邊的面板列出所有開啟中和最近的聊天，每個都帶狀態燈。點一個，就能看到它裡面的智慧體、各自在哪一步、用了多少 token 和費用。
- **需要你的時候馬上知道。** 等你核准或回答的聊天會亮洋紅色燈；完成和出錯也各有顏色，狀態列上同樣看得到。
- **不在電腦前也能收到提醒。** 聊天開始等你時，VS Code 或系統會通知你，願意的話還能響一聲；也可以把簡短訊息推播到手機或團隊聊天（ntfy、Bark、Server酱、飛書、釘釘、企業微信、Telegram、Discord、Slack），出錯和碰到額度上限時也會推播。設好勿擾時段，夜裡就不會打擾你。
- **快到上限前先提醒你。** Codex 用量到 90% 時會提醒你；開啟相應設定後，今天的估算費用超過你訂的預算、某個聊天的上下文快到自動壓縮點時，也會提醒你。
- **把上下文管好。** 看到每個聊天用了多滿；在面板裡直接壓縮（可以換便宜的模型，先看費用估算）；自己決定什麼時候自動壓縮；快取快過期前提醒你。
- **碰到額度上限後接著做。** 顯示額度什麼時候重置，並準備好繼續用的提示詞或命令，複製就能用。
- **看看這段時間用了多少。** 用量歷史頁面按天顯示 Claude Code 和 Codex 最近 30 天的估算費用和 token，也能依模型拆開來看。
- **知道聊天記錄存在哪。** 看到 Claude Code 和 Codex 的聊天記錄佔了多少空間，並提供把它們搬到別的磁碟的參考命令。

它只讀取所支援的工具本來就寫在你電腦上的記錄，不收集任何資料；除非你開啟 **允許連網**（預設關閉），擴充功能本身不連網；目前只有推播通知會用到它。

## 支援的工具

- **Claude Code** 和 **Codex**：VS Code 擴充功能、命令列或桌面應用程式裡的，包括它們的子智慧體。
- **GitHub Copilot Chat**：VS Code 內建的聊天，包括智慧體模式。
- **Gemini CLI** 和 **Qwen Code**，目前是**預覽**。對它們的支援是依照官方公開的記錄格式做的，還沒有用真實工作階段驗證過。如果發現不對勁的地方，歡迎到 [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues) 回報。

沒安裝的工具會直接略過，每個工具也都能在設定裡個別關閉。各工具能看到的內容不完全一樣：例如 Copilot Chat 顯示的是 Copilot credits，而不是美元費用；Gemini CLI 的狀態是推測出來的。壓縮、用量歷史、今日總費用和儲存頁面只涵蓋 Claude Code 和 Codex。詳見完整使用指南裡的[支援的工具](docs/GUIDE.zh-TW.md#支援的工具)。

## 開始使用

1. 點上面的 **在 VS Code 中安裝**，或在擴充功能檢視裡搜尋 **CYUNEO Agent Monitor**。
2. 開啟底部面板裡 Terminal 旁邊的 **智慧體監視器** 分頁。
3. 點清單裡的一個聊天，就能看到它的智慧體。

所有功能、命令和設定的詳細說明，請見 **[完整使用指南](docs/GUIDE.zh-TW.md)**。

## 系統需求

- VS Code 1.94 或更高版本。
- 在同一台電腦上使用至少一個支援的工具：Claude Code 或 Codex（VS Code 擴充功能、命令列或桌面應用程式）、VS Code 裡的 GitHub Copilot Chat、Gemini CLI 或 Qwen Code。
- 要在背景壓縮一個已關閉的聊天視窗，還需要 Claude Code 命令列。擴充功能會先在 PATH 裡找 `claude`，再到已安裝的 Claude Code 擴充功能裡找。你也可以設定 `agentMonitor.claude.cliPath`。
- 自動化測試在 macOS、Windows 和 Linux 上執行（Node.js 22，Linux 上另有 Node.js 20）。在 VS Code 裡的實際使用測試目前只在 macOS 上做過。

## 隱私

- 沒有遙測；除非你開啟 **允許連網**（預設關閉），擴充功能本身不連網，目前只有推播通知會用到它。你的對話只留在你自己的電腦上。
- 推播通知是選用的，預設關閉。開啟後，只有一則簡短訊息會傳到你設定的服務：專案資料夾名稱和狀態（你允許的話再加上對話標題和子智慧體名稱）。其他任何內容都不會離開你的電腦。
- 用量歷史在你的電腦上計算，提示音由你自己的系統播放，都不會傳出任何資料。
- 只有在你確認之後，它才會修改檔案或執行 Claude Code（見[免責聲明](#免責聲明)）。
- 詳見指南裡的[它讀什麼](docs/GUIDE.zh-TW.md#它讀什麼)和[隱私](docs/GUIDE.zh-TW.md#隱私)。

## 非官方聲明

CYUNEO Agent Monitor 是一個獨立的、非官方的專案，與 Anthropic、OpenAI、GitHub、Microsoft、Google 或 Alibaba 沒有關聯，未獲其認可或贊助。產品名稱歸其各自所有者所有，這裡使用它們僅為說明本擴充功能所對接的對象。

## 授權條款

CYUNEO Agent Monitor 依 [PolyForm Noncommercial License 1.0.0](LICENSE) 授權，**個人和非商業用途免費**。本專案公開原始碼，但不是開源軟體。

- **無須申請即可使用：** 個人使用、學習、業餘專案和研究，以及慈善機構、教育機構、公共研究機構、公共安全或衛生機構、環保組織和政府機關使用。基於這些目的，你也可以修改程式碼並分享，但要一併附上授權條款和 `Required Notice` 那一行。
- **需要另外取得商業授權：** 其他用途都需要，例如在公司裡用於工作、放進產品或服務、拿去販售。洽詢商業授權，請在 [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues) 新增一個標題為「Commercial license」的 issue。
- 以上只是方便閱讀的摘要，具有約束力的只有[授權條款原文](LICENSE)。

## 免責聲明

- **不提供任何擔保。** 本擴充功能依「現狀」提供，不附帶任何形式的擔保。在法律允許的範圍內，作者不對使用本擴充功能造成的任何損失或損害負責，包括資料遺失、工作成果遺失、額外費用或帳號問題。
- **只在你確認後才動手。** 本擴充功能讀取你電腦上的工作階段記錄。只有在你確認之後，它才會修改檔案或執行 Claude Code：修改自動壓縮設定（只改一項，並留有備份）、在背景壓縮、寫交接筆記。
- **用量和費用由你承擔。** 背景壓縮和交接筆記執行的是你自己的 Claude Code，會計入你方案的用量額度或 API 帳單。顯示的費用是依官方價目表估算的，不是帳單。
- **遷移資料風險自負。** 儲存頁只提供參考命令，由你自己核對並決定是否執行。
- **遵守各服務的條款。** 你需要自行確保對你所監控的 AI 程式設計工具及其服務，以及你設定的推播服務的使用符合它們的條款。
- **不構成專業建議。** 上下文與壓縮小提示整理自公開資料，可能已經過時。

## 著作權與商標

- © 2026 Chenyu Guo。授權條款未明確授予的一切權利均予保留。
- 本專案由 Chenyu Guo 在 AI 輔助下開發（主要使用 Claude Code）。產品構想、需求和設計決定來自作者本人，結果也經過作者審閱。
- CYUNEO™ 名稱和標誌不在授權範圍內。不得用於你自己的產品，也不得以任何方式暗示你的版本來自 CYUNEO 或獲得 CYUNEO 認可。
- 未取得授權而商用、刪除著作權或授權聲明、或者換個名字當作自己的作品重新發布，都侵害作者的權利。作者可以要求 GitHub、Visual Studio Marketplace、Open VSX 等平台下架這類副本，並保留採取進一步法律行動的權利。
- 如果發現有人違反授權條款使用或販售本專案，請在 [GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues) 告訴我們。

## 支援與安全

- 提問、錯誤回報和想法：[GitHub Issues](https://github.com/cyuneo/cyuneo-agent-monitor/issues)，詳見 [SUPPORT.md](SUPPORT.md)。
- 安全問題：請依 [SECURITY.md](SECURITY.md) 中的說明私下回報。
- 發布紀錄：[CHANGELOG.md](CHANGELOG.md)。第三方元件：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

CYUNEO™ / Connect Intelligence. Create Your Universe.

© 2026 Chenyu Guo. Free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). The CYUNEO™ name and logo are not licensed.