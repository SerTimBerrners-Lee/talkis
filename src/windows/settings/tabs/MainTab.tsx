import { useState, useEffect, useMemo } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { clearHistory, DEFAULT_HOTKEY, deleteHistoryEntry, formatHotkeyLabel, getHistory, getSettings, HistoryEntry } from "../../../lib/store";
import { AlertCircle, Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import { HISTORY_CLEARED_EVENT, HISTORY_DELETED_EVENT, HISTORY_UPDATED_EVENT, SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import { retryHistoryEntry } from "../../widget/services/transcriptionPipeline";

interface MainTabProps {
  initialHistory?: HistoryEntry[];
}

interface HistoryGroup {
  id: string;
  label: string;
  items: HistoryEntry[];
}

function formatDayLabel(timestamp: string): string {
  const entryDate = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfEntryDay = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfEntryDay.getTime()) / 86400000);

  if (diffDays === 0) return "Сегодня";
  if (diffDays === 1) return "Вчера";

  return entryDate.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
}
export function MainTab({ initialHistory = [] }: MainTabProps) {
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [copied, setCopied] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retrySucceededId, setRetrySucceededId] = useState<string | null>(null);
  const [hotkeyLabel, setHotkeyLabel] = useState(formatHotkeyLabel(DEFAULT_HOTKEY));
  const [isClearArmed, setIsClearArmed] = useState(false);

  useEffect(() => {
    const syncHotkeyLabel = async () => {
      const settings = await getSettings();
      setHotkeyLabel(formatHotkeyLabel(settings.hotkey || DEFAULT_HOTKEY));
    };

    getHistory().then(setHistory);
    void syncHotkeyLabel();

    const unlistenHistory = listen<HistoryEntry>(HISTORY_UPDATED_EVENT, (event) => {
      setHistory((current) => {
        const existingIndex = current.findIndex((item) => item.id === event.payload.id);

        if (existingIndex === -1) {
          return [event.payload, ...current].slice(0, 500);
        }

        return current.map((item) => (item.id === event.payload.id ? event.payload : item));
      });
    });

    const unlistenSettings = listen(SETTINGS_UPDATED_EVENT, () => {
      void syncHotkeyLabel();
    });

    return () => {
      unlistenHistory.then((unlisten) => unlisten());
      unlistenSettings.then((unlisten) => unlisten());
    };
  }, []);

  const deleteEntry = async (id: string) => {
    await deleteHistoryEntry(id);
    setHistory((h) => h.filter((x) => x.id !== id));
    await emit(HISTORY_DELETED_EVENT, { id });
  };

  const clearAllHistory = async () => {
    if (!isClearArmed) {
      setIsClearArmed(true);
      setTimeout(() => {
        setIsClearArmed((current) => current ? false : current);
      }, 2500);
      return;
    }

    await clearHistory();
    setHistory([]);
    setIsClearArmed(false);
    await emit(HISTORY_CLEARED_EVENT);
  };

  const copyText = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied((current) => (current === id ? null : current)), 1500);
  };

  const retryEntry = async (entry: HistoryEntry) => {
    setRetryingId(entry.id);

    try {
      const settings = await getSettings();
      await retryHistoryEntry(entry, settings, { shouldPaste: false });
      setRetrySucceededId(entry.id);
      setTimeout(() => {
        setRetrySucceededId((current) => (current === entry.id ? null : current));
      }, 1800);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось повторно отправить запись.";

      setHistory((current) => current.map((item) => (
        item.id === entry.id
          ? {
              ...item,
              status: "failed",
              errorMessage: message,
            }
          : item
      )));
    } finally {
      setRetryingId((current) => (current === entry.id ? null : current));
    }
  };

  const groupedHistory = useMemo<HistoryGroup[]>(() => {
    const groups: HistoryGroup[] = [];

    for (const item of history) {
      const label = formatDayLabel(item.timestamp);
      const existing = groups[groups.length - 1];

      if (!existing || existing.label !== label) {
        groups.push({
          id: `${new Date(item.timestamp).toISOString().slice(0, 10)}-${groups.length}`,
          label,
          items: [item],
        });
        continue;
      }

      existing.items.push(item);
    }

    return groups;
  }, [history]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section
        className="card"
        style={{
          display: "grid",
          gap: 12,
          padding: 18,
          background: "rgba(255,255,255,0.72)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6, maxWidth: 560 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)" }}>
              Как начать запись
            </div>
            <div style={{ fontSize: 14, color: "var(--text-mid)", lineHeight: 1.7 }}>
              Удерживайте горячую клавишу, говорите и отпустите ее, когда закончите. После обработки текст вставится автоматически.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-hi)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ color: "var(--text-low)", letterSpacing: "0.08em" }}>Комбинация</span>
            <span>{hotkeyLabel}</span>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)", margin: "0 0 4px", letterSpacing: "-0.03em" }}>
              История записей
            </h2>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
              {history.length > 0
                ? `Последние записи доступны для копирования и удаления.`
                : `Записей пока нет. Удерживайте ${hotkeyLabel} для записи.`}
            </div>
          </div>

          {history.length > 0 && (
            <button
              onClick={() => {
                void clearAllHistory();
              }}
              className={isClearArmed ? "btn btn-danger" : "btn"}
              style={{ minHeight: 34, padding: "0 12px" }}
              title={isClearArmed ? "Нажмите еще раз, чтобы очистить всю историю" : "Очистить всю историю"}
            >
              <Trash2 size={12} strokeWidth={2} /> {isClearArmed ? "Подтвердить" : "Очистить"}
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gap: 20,
          }}
        >
          {history.length === 0 ? (
            <div style={{ padding: "32px 20px", borderRadius: 12, border: "1px dashed rgba(0,0,0,0.12)", textAlign: "center" }}>
              <div style={{ width: 56, height: 56, borderRadius: 999, background: "#000", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <span className="headline-accent" style={{ fontSize: 24, fontStyle: "italic" }}>◎</span>
              </div>
              <div className="label" style={{ marginBottom: 10 }}>История пуста</div>
              <p style={{ margin: 0, fontSize: 14, color: "var(--text-mid)", lineHeight: 1.7 }}>
                Записей пока нет. Удерживайте <b>{hotkeyLabel}</b> для записи.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {groupedHistory.map((group) => (
              <div key={group.id} style={{ display: "grid", gap: 8 }}>
                <div className="label" style={{ paddingLeft: 4 }}>{group.label}</div>
                <table className="b-table" style={{ background: "transparent" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 110 }}>Время</th>
                        <th>Текст</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((item, index) => (
                        <tr key={item.id} onDoubleClick={() => navigator.clipboard.writeText(item.cleaned)} style={{ borderBottom: index < group.items.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none", cursor: "default" }}>
                          <td style={{ whiteSpace: "nowrap", verticalAlign: "top", color: "var(--text-low)" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <span>
                              {new Date(item.timestamp).toLocaleTimeString("ru-RU", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                              </span>
                              {item.processingTime != null && (
                                <span style={{ fontSize: 10, opacity: 0.55, letterSpacing: "0.02em" }}>
                                  {item.processingTime < 1000
                                    ? `${item.processingTime}мс`
                                    : `${(item.processingTime / 1000).toFixed(1)}с`}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ verticalAlign: "top" }}>
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
                               <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 8 }}>
                                  {item.status === "failed" ? (
                                    <>
                                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 999, background: "rgba(143,45,32,0.08)", border: "1px solid rgba(143,45,32,0.14)", color: "var(--danger)", fontSize: 12, lineHeight: 1.4, width: "fit-content" }}>
                                        <AlertCircle size={13} strokeWidth={2} />
                                        <span>Обработка не завершилась</span>
                                      </div>
                                      <div style={{ color: "var(--text-mid)", lineHeight: 1.7, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                                        {item.errorMessage || "Аудио сохранено локально. Можно отправить повторно."}
                                      </div>
                                    </>
                                  ) : (
                                    <span style={{ color: "var(--text-mid)", lineHeight: 1.7, overflowWrap: "anywhere", wordBreak: "break-word" }}>{item.cleaned}</span>
                                  )}
                                </div>
                                 {item.status === "failed" ? (
                                    <button
                                      onClick={() => retryEntry(item)}
                                      className="btn"
                                      disabled={retryingId === item.id}
                                      style={{ minWidth: 96, height: 32, minHeight: 32, padding: "0 10px", flexShrink: 0, borderRadius: 999 }}
                                      title="Отправить повторно"
                                    >
                                      <RotateCcw size={12} strokeWidth={2} style={{ opacity: retryingId === item.id ? 0.45 : 1 }} />
                                      <span style={{ opacity: retryingId === item.id ? 0.6 : 1 }}>
                                        {retryingId === item.id ? "Повтор..." : "Повторить"}
                                      </span>
                                    </button>
                                ) : (
                                  <button onClick={() => copyText(item.id, item.cleaned)} className="btn" style={{ width: 32, minWidth: 32, height: 32, minHeight: 32, padding: 0, flexShrink: 0, borderRadius: 8 }} title={retrySucceededId === item.id ? "Успешно" : "Скопировать"}>
                                    {copied === item.id || retrySucceededId === item.id ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
                                  </button>
                                )}
                               <button onClick={() => deleteEntry(item.id)} className="btn btn-danger" style={{ width: 32, minWidth: 32, height: 32, minHeight: 32, padding: 0, flexShrink: 0, borderRadius: 8 }} title="Удалить">
                                 <Trash2 size={12} strokeWidth={2} />
                               </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
