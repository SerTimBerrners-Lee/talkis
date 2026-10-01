export const widget = {
  // ── Widget.tsx: microphone start errors (call capture) ──────────────────
  "widget.mic.permissionDenied": {
    ru: "Разрешите микрофон для записи созвона.",
    en: "Allow microphone access to record the call.",
  },
  "widget.mic.busy": {
    ru: "Микрофон занят или недоступен. Закройте приложения, которые могут использовать микрофон, и попробуйте снова.",
    en: "The microphone is busy or unavailable. Close apps that may be using the microphone and try again.",
  },
  "widget.mic.unavailable": {
    ru: "Выбранный микрофон недоступен. Проверьте микрофон в настройках Talkis.",
    en: "The selected microphone is unavailable. Check the microphone in Talkis settings.",
  },
  "widget.mic.startTimeout": {
    ru: "Микрофон не успел запуститься. Попробуйте ещё раз.",
    en: "The microphone didn't start in time. Try again.",
  },
  "widget.mic.accessFailed": {
    ru: "Не удалось получить доступ к микрофону для записи созвона.",
    en: "Couldn't access the microphone to record the call.",
  },

  // ── Widget.tsx: call capture start errors ───────────────────────────────
  "widget.call.pipewireFailed": {
    ru: "Не удалось начать запись системного звука Linux. Убедитесь, что PipeWire запущен и есть активное устройство вывода.",
    en: "Couldn't start Linux system audio capture. Make sure PipeWire is running and an output device is active.",
  },
  "widget.call.systemAudioUnsupported": {
    ru: "Запись системного звука не поддерживается на этой платформе.",
    en: "System audio capture isn't supported on this platform.",
  },
  "widget.call.windowsOutputMissing": {
    ru: "Не найдено устройство вывода Windows для записи системного звука.",
    en: "No Windows output device found for system audio capture.",
  },
  "widget.call.windowsCaptureFailed": {
    ru: "Не удалось начать запись системного звука Windows.",
    en: "Couldn't start Windows system audio capture.",
  },
  "widget.call.systemAudioPermission": {
    ru: "Разрешите запись звука системы для созвона.",
    en: "Allow system audio capture for the call.",
  },
  "widget.call.startFailed": {
    ru: "Не удалось начать запись созвона. Проверьте разрешения микрофона и звука системы.",
    en: "Couldn't start the call recording. Check the microphone and system audio permissions.",
  },
  "widget.call.processFailed": {
    ru: "Не удалось обработать запись. Попробуйте повторить попытку.",
    en: "Couldn't process the recording. Please try again.",
  },

  // ── Widget.tsx: file processing / interrupted ───────────────────────────
  "widget.processing.interrupted": {
    ru: "Обработка остановлена. Можно запустить повторно.",
    en: "Processing stopped. You can run it again.",
  },

  // ── Widget.tsx: FileDropPill text ───────────────────────────────────────
  "widget.fileDrop.transcribingPercent": {
    ru: "Транскрибация {percent}%",
    en: "Transcribing {percent}%",
  },
  "widget.fileDrop.transcribing": {
    ru: "Транскрибация",
    en: "Transcribing",
  },
  "widget.fileDrop.release": {
    ru: "Отпустите файл",
    en: "Drop the file",
  },

  // ── Widget.tsx: CallBubble titles ───────────────────────────────────────
  "widget.callBubble.error": {
    ru: "Ошибка созвона",
    en: "Call error",
  },
  "widget.callBubble.requestingAccess": {
    ru: "Запрашиваем доступы",
    en: "Requesting permissions",
  },
  "widget.callBubble.transcribing": {
    ru: "Транскрибируем разговор",
    en: "Transcribing the conversation",
  },
  "widget.callBubble.ready": {
    ru: "Созвон готов",
    en: "Call ready",
  },
  "widget.callBubble.stopAndTranscribe": {
    ru: "Завершить и транскрибировать",
    en: "Finish and transcribe",
  },
  "widget.callBubble.record": {
    ru: "Запись разговора",
    en: "Record the conversation",
  },
  // ── Widget.tsx: IdlePill / RecordingPill buttons ────────────────────────
  "widget.idle.startRecording": {
    ru: "Начать запись",
    en: "Start recording",
  },
  "widget.idle.copyLatest": {
    ru: "Скопировать последнюю запись",
    en: "Copy the latest recording",
  },
  "widget.idle.copied": {
    ru: "Скопировано",
    en: "Copied",
  },
  "widget.idle.copy": {
    ru: "Скопировать",
    en: "Copy",
  },
  "widget.recording.stopRecording": {
    ru: "Закончить запись",
    en: "Stop recording",
  },

  // ── transcriptionPipeline.ts: user-facing transcription errors ──────────
  "widget.error.modelNotDownloaded": {
    ru: "Локальный runtime запущен, но модель {model} ещё не скачана. Откройте Настройки -> Модели -> Локально и нажмите «Скачать».",
    en: "The local runtime is running, but the {model} model hasn't been downloaded yet. Open Settings -> Models -> Local and click “Download”.",
  },
  "widget.error.localRuntimeStartFailed": {
    ru: "Не удалось запустить локальный runtime распознавания. Откройте Настройки -> Модели -> Локально и нажмите «Скачать» для нужной Whisper-модели.",
    en: "Couldn't start the local recognition runtime. Open Settings -> Models -> Local and click “Download” for the Whisper model you need.",
  },
  "widget.error.localRuntimeRejected": {
    ru: "Локальный runtime распознавания отклонил запрос. Перезапустите локальную модель или выберите её заново в Настройки -> Модели -> Локально.",
    en: "The local recognition runtime rejected the request. Restart the local model or select it again in Settings -> Models -> Local.",
  },
  "widget.error.regionUnsupported": {
    ru: "Сервис распознавания сейчас недоступен в вашем регионе. Попробуйте другой endpoint или VPN.",
    en: "The recognition service is currently unavailable in your region. Try a different endpoint or a VPN.",
  },
  "widget.error.subscriptionRequired": {
    ru: "Облачный баланс закончился. Пополните его в личном кабинете Talkis.",
    en: "Your cloud balance is empty. Top it up in your Talkis account.",
  },
  "widget.error.requestRejected": {
    ru: "Сервис отклонил запрос. Проверьте API-ключ, регион доступа или настройки endpoint.",
    en: "The service rejected the request. Check the API key, access region, or endpoint settings.",
  },
  "widget.error.cloudSessionExpired": {
    ru: "Сессия Talkis Cloud истекла. Войдите в облако заново.",
    en: "Your Talkis Cloud session has expired. Sign in to the cloud again.",
  },
  "widget.error.cloudSignInRequired": {
    ru: "Войдите в Talkis Cloud заново, чтобы использовать облачный режим.",
    en: "Sign in to Talkis Cloud again to use cloud mode.",
  },
  "widget.error.cloudInvalidResponse": {
    ru: "Talkis Cloud вернул некорректный ответ. Попробуйте отправить запись ещё раз.",
    en: "Talkis Cloud returned an invalid response. Try submitting the recording again.",
  },
  "widget.error.cloudUnavailable": {
    ru: "Talkis Cloud временно недоступен. Попробуйте ещё раз через несколько секунд.",
    en: "Talkis Cloud is temporarily unavailable. Try again in a few seconds.",
  },
  "widget.error.authFailed": {
    ru: "Не удалось авторизоваться в API. Проверьте ваш ключ доступа.",
    en: "Couldn't authenticate with the API. Check your access key.",
  },
  "widget.error.rateLimited": {
    ru: "Превышен лимит запросов или закончилась квота API. Попробуйте позже.",
    en: "The request limit was exceeded or the API quota ran out. Try again later.",
  },
  "widget.error.networkFailed": {
    ru: "Не удалось связаться с сервером. Проверьте интернет и попробуйте снова.",
    en: "Couldn't reach the server. Check your internet connection and try again.",
  },
  "widget.error.serverUnavailable": {
    ru: "Сервис временно недоступен. Попробуйте повторить отправку чуть позже.",
    en: "The service is temporarily unavailable. Try resubmitting a little later.",
  },
  "widget.error.processingFailed": {
    ru: "Не удалось обработать запись. Попробуйте отправить ее повторно.",
    en: "Couldn't process the recording. Try submitting it again.",
  },
  "widget.error.noSavedAudio": {
    ru: "У этой записи нет сохраненного аудио для повторной отправки.",
    en: "This entry has no saved audio to resubmit.",
  },
  "widget.error.speechNotRecognized": {
    ru: "Речь не распознана. Попробуйте отправить запись еще раз.",
    en: "No speech recognized. Try submitting the recording again.",
  },
  "widget.error.translationModelUnavailable": {
    ru: "Для перевода нужна текстовая модель. Выберите облако, локальную текстовую модель или LLM endpoint в «Настройки → Модели».",
    en: "Translation needs a text model. Choose cloud, a local text model, or an LLM endpoint in “Settings → Models”.",
  },
  "widget.selectionTranslation.noSelection": {
    ru: "Выделенный текст не найден.",
    en: "No selected text found.",
  },
  "widget.selectionTranslation.noModel": {
    ru: "Для перевода нужна текстовая модель. Выберите облако, локальную текстовую модель или LLM endpoint в «Настройки → Модели».",
    en: "Translation needs a text model. Choose cloud, a local text model, or an LLM endpoint in “Settings → Models”.",
  },
  "widget.selectionTranslation.copyFailed": {
    ru: "Не удалось прочитать выделенный текст через буфер обмена.",
    en: "Couldn't read the selected text through the clipboard.",
  },
  "widget.selectionTranslation.emptyResult": {
    ru: "Модель вернула пустой перевод.",
    en: "The model returned an empty translation.",
  },
  "widget.selectionTranslation.done": {
    ru: "Выделенный текст переведен.",
    en: "Selected text translated.",
  },

  // ── useWidgetRecording.ts: status / error notices ───────────────────────
  "widget.recording.lowMic": {
    ru: "Микрофон слышит слишком тихо. Поднесите его ближе или проверьте выбранное устройство.",
    en: "The microphone is picking up too quietly. Move it closer or check the selected device.",
  },
  "widget.recording.settingsNotLoaded": {
    ru: "Настройки не загружены. Перезапустите приложение.",
    en: "Settings aren't loaded. Restart the app.",
  },
  "widget.recording.cloudSignInRequired": {
    ru: "Войдите в Talkis Cloud заново, чтобы использовать облачный режим.",
    en: "Sign in to Talkis Cloud again to use cloud mode.",
  },
  "widget.recording.noModelConfigured": {
    ru: "Сначала установите модель в «Настройки → Модели»: облако, локальная модель или свой API-ключ.",
    en: "First set up a model in “Settings → Models”: cloud, a local model, or your own API key.",
  },
  "widget.recording.micAccessDenied": {
    ru: "Нет доступа к микрофону. Разрешите доступ в системных настройках.",
    en: "No microphone access. Allow access in your system settings.",
  },
  "widget.recording.startError": {
    ru: "Ошибка запуска записи: {error}",
    en: "Recording start error: {error}",
  },
  "widget.recording.unknownError": {
    ru: "Неизвестная ошибка",
    en: "Unknown error",
  },
  "widget.recording.noAudioRecorded": {
    ru: "Аудио не записано. Попробуйте еще раз.",
    en: "No audio was recorded. Try again.",
  },
  "widget.recording.microphoneInterrupted": {
    ru: "Запись остановлена: микрофон перестал передавать звук. Слова после обрыва не записаны. Проверьте микрофон перед новой записью.",
    en: "Recording stopped: the microphone stopped sending audio. Words after the interruption were not recorded. Check your microphone before starting again.",
  },
  "widget.recording.speechNotRecognized": {
    ru: "Речь не распознана. Попробуйте еще раз.",
    en: "No speech recognized. Try again.",
  },
  "widget.recording.maxDurationReached": {
    ru: "Запись остановлена: достигнут лимит 5 минут.",
    en: "Recording stopped: the 5-minute limit was reached.",
  },
  "widget.recording.processingError": {
    ru: "Ошибка обработки",
    en: "Processing error",
  },

  // ── useWidgetHotkey.ts: hotkey errors ───────────────────────────────────
  "widget.hotkey.invalidFormat": {
    ru: "Неверный формат горячей клавиши",
    en: "Invalid hotkey format",
  },
  "widget.hotkey.registerFailed": {
    ru: "Не удалось зарегистрировать горячую клавишу \"{hotkey}\". Возможно, сочетание занято другим приложением.",
    en: "Couldn't register the hotkey \"{hotkey}\". The combination may be in use by another app.",
  },
  "widget.hotkey.registerFailedGeneric": {
    ru: "Не удалось зарегистрировать горячую клавишу.",
    en: "Couldn't register the hotkey.",
  },
  "widget.hotkey.conflict": {
    ru: "Это сочетание уже используется другой функцией Talkis.",
    en: "This shortcut is already used by another Talkis feature.",
  },
} as const;
