<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Иконка приложения Talkis">
</p>

<h1 align="center">Talkis</h1>

<p align="center">
  Открытый десктопный голосовой ввод для людей, которые каждый день пишут в рабочих приложениях.
</p>

<p align="center">
  <a href="README.md">Read in English</a>
  ·
  <a href="https://talkis.ru">Сайт</a>
  ·
  <a href="https://github.com/SerTimBerrners-Lee/talkis/releases/latest">Последний релиз</a>
</p>

<p align="center">
  <img src="docs/demo/demo-1.gif" alt="Talkis диктует запрос для разработки в редакторе кода" width="860">
</p>

## Что такое Talkis?

Talkis - десктопное приложение для преобразования речи в текст на Tauri, React, TypeScript и Rust. Оно работает как маленький плавающий виджет: записывает голос по горячей клавише, распознает речь, при необходимости улучшает текст через LLM и вставляет результат в активное приложение.

Talkis сделан для повседневной работы: IDE, чаты, заметки, CRM-поля, письма, файлы и транскрипты созвонов.

## Главное

- Диктовка в любое активное текстовое поле через глобальную горячую клавишу.
- Режим закрепленной записи для длинной речи без удержания клавиш.
- Автоматическая вставка очищенного текста после распознавания.
- Работа через облако, собственный API-ключ или локальные STT-модели.
- Транскрибация аудио и видео из вкладки `Файлы` или через перетаскивание файла на виджет.
- Запись созвонов на macOS с отдельными дорожками микрофона и системного аудио.
- Локальная история голосовых записей и файловых транскрибаций.
- Управляемые локальные рантаймы для Whisper, Qwen ASR, NVIDIA Parakeet и diarization.
- Нативные сборки для macOS, Windows и Linux.

## Демонстрация

В репозиторий добавлены те же GIF-демо, которые используются на сайте Talkis.

| Демо | Что показывает |
| --- | --- |
| [Диктовка кода](docs/demo/demo-1.gif) | Короткий запрос для разработки, вставленный в редактор |
| [Диктовка письма](docs/demo/demo-2.gif) | Превращение речи в деловое письмо |
| [Диктовка заметки](docs/demo/demo-3.gif) | Быстрые заметки и задачи |
| [Запись созвона](docs/demo/demo-4.gif) | Отдельный сценарий записи разговора из виджета |
| [Транскрибация файла](docs/demo/demo-5.gif) | Обработка аудио или видеофайла |
| [Выбор моделей](docs/demo/demo-6.gif) | Локальные модели и собственный API |

<details>
<summary>Показать остальные демо прямо здесь</summary>

### Диктовка письма

<img src="docs/demo/demo-2.gif" alt="Talkis диктует письмо" width="860">

### Заметки

<img src="docs/demo/demo-3.gif" alt="Talkis диктует заметку" width="860">

### Запись созвона

<img src="docs/demo/demo-4.gif" alt="Talkis записывает транскрипт созвона" width="860">

### Транскрибация файла

<img src="docs/demo/demo-5.gif" alt="Talkis транскрибирует аудио или видеофайл" width="860">

### Локальные модели и API-ключи

<img src="docs/demo/demo-6.gif" alt="Talkis выбирает локальную модель или собственный API-ключ" width="860">

</details>

## Как это работает

1. Поставьте фокус в поле, куда нужно вставить текст.
2. Удерживайте `Shift + Command + Space` на macOS.
3. Говорите естественно.
4. Отпустите горячую клавишу.
5. Talkis распознает, очистит и вставит текст.

Горячая клавиша, микрофон, язык, источник моделей, стиль обработки текста и тема приложения настраиваются в настройках.

## Режимы работы

### Talkis Cloud

Войдите в [Talkis Cloud](https://talkis.ru) и используйте распознавание без управления API-ключами. Запросы идут через `proxy.talkis.ru`.

### Собственный API-ключ

Можно использовать OpenAI-совместимый STT endpoint и отдельный LLM endpoint для очистки текста. Во вкладке `Модели` также есть карточки API-адаптеров для поддерживаемых провайдеров.

Поддерживаемые имена STT-моделей:

- `whisper-1`
- `gpt-4o-transcribe`
- `gpt-4o-mini-transcribe`

### Локальные модели

Установите и запустите управляемые Talkis локальные рантаймы из настроек. Локальный режим отвечает только за транскрибацию, если отдельно не настроен LLM endpoint.

Управляемые локальные рантаймы:

- Whisper, endpoint по умолчанию `http://127.0.0.1:8000`
- NVIDIA Parakeet MLX, endpoint по умолчанию `http://127.0.0.1:8001`
- Qwen ASR, endpoint по умолчанию `http://127.0.0.1:8002`
- Speaker diarization, endpoint по умолчанию `http://127.0.0.1:8003`

Если порт по умолчанию занят, Talkis запускает управляемый рантайм на свободном fallback-порту и сохраняет фактический endpoint в настройках.

## Установка

Скачайте последнюю сборку из GitHub Releases:

- [macOS DMG](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-macos.dmg)
- [Windows x64 installer](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-windows-x64-setup.exe)
- [Linux x64 AppImage](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-linux-x64.AppImage)

При первом запуске выдайте нужные разрешения:

- доступ к микрофону для записи;
- Accessibility на macOS для автоматической вставки текста;
- Screen and System Audio Recording на macOS для записи созвонов.

## Транскрибация файлов

Вкладка `Файлы` поддерживает транскрибацию аудио и видео до 8 ГБ. Файлы обрабатываются через нативный path-based pipeline, поэтому большие файлы не загружаются в память WebView.

Talkis использует встроенный ffmpeg sidecar для видео, неподдерживаемых аудиоформатов, чанкинга и подготовки diarization. Готовые `16 kHz` mono PCM WAV файлы могут пропускать конвертацию для локального STT.

Разделение по говорящим доступно через Talkis Cloud или через локальный Whisper плюс локальный diarization runtime - в зависимости от выбранного режима.

## Запись созвонов

На macOS запись созвона собирает две дорожки:

- `Вы` из микрофона.
- `Созвон` из системного аудио.

Windows и Linux пока возвращают явный unsupported-state для записи системного аудио созвонов. Поддержка появится после реализации WASAPI loopback и PipeWire monitor capture.

## Приватность

- В облачном режиме запросы идут через `proxy.talkis.ru`.
- В режиме собственного ключа запросы идут напрямую в настроенные endpoints.
- В локальном режиме транскрибация остается на вашем компьютере.
- API-ключи и device token хранятся локально в настройках приложения.
- История голосовых записей и файловых транскрибаций хранится локально.
- Talkis не хранит аудио на своих серверах дольше самого API-вызова.

## Диагностика

- Текст не вставляется: проверьте macOS System Settings -> Privacy & Security -> Accessibility и убедитесь, что Talkis включен.
- В распознавании появляются неожиданные иностранные символы: выберите фиксированный язык, например `ru` или `en`, вместо auto.
- Локальный STT возвращает ошибки модели: откройте `Модели` -> `Локально`, убедитесь, что модель установлена и выбрана, затем переустановите ее, если runtime сообщает о потерянных файлах.
- Запись созвона не стартует на macOS: выдайте разрешения Microphone и Screen and System Audio Recording, затем перезапустите Talkis.
- Нужна подробная диагностика: откройте `~/.talkis/talkis.log` или запустите `bun run logs` во время разработки.

## Разработка

Требования:

- Bun `1.2.x`
- Rust stable
- системные зависимости Tauri v2

Установка зависимостей и запуск:

```bash
bun install
bun run prepare:sidecars
bun run tauri dev
```

Полезные команды:

```bash
bunx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
bun run check:release
bun run tauri build
bun run build:release:macos
bun run logs
```

На Ubuntu/Debian сначала установите нативные зависимости Tauri и сборки sidecar-ов:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev libasound2-dev librsvg2-dev patchelf clang libclang-dev cmake
```

## Структура проекта

```text
src/                  React и TypeScript frontend
src/windows/widget/   Плавающий widget window
src/windows/settings/ Окно настроек и вкладки
src/lib/              Store, auth, permissions, logging, shared clients
src-tauri/src/        Rust backend, Tauri commands, audio, paste, STT
src-tauri/icons/      Иконки приложения
docs/                 Release docs, audio rules, demo media
scripts/              Release и sidecar preparation scripts
```

Перед изменениями в аудио, транскрибации, локальном STT, файловой обработке или call-capture прочитайте [docs/audio-pipeline-principles.md](docs/audio-pipeline-principles.md).

## Технологии

- Tauri v2
- React 19
- TypeScript
- Rust
- cpal native microphone recording
- OpenAI-compatible STT и LLM APIs
- Managed local STT sidecars
- Bundled ffmpeg sidecar

## Как помочь проекту

Issues и pull requests приветствуются. Перед изменением аудио-поведения прочитайте документ про audio pipeline и сохраняйте достаточно логов для отладки recorder stats, ffmpeg timing, выбора STT endpoint, прогресса чанков и уровней call-capture.

Конвенции проекта:

- Тексты интерфейса - на русском.
- Код и комментарии - на английском.
- Package manager - Bun.
- Настройки сохраняются сразу после изменения.
- Release workflow описан в [docs/release/rule.md](docs/release/rule.md).

## Лицензия

В этом checkout пока нет файла лицензии. Добавьте `LICENSE` перед публикацией репозитория как полноценного open-source проекта или перед приемом внешних контрибьюторов.

## Статус

Talkis активно развивается. Текущая версия: `0.1.24`.
