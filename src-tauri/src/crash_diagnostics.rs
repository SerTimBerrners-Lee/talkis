use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

static CRASH_LOG: OnceLock<File> = OnceLock::new();

pub fn init() {
    install(&crate::logger::get_log_path());
}

fn install(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    if CRASH_LOG.set(file).is_err() {
        return;
    }

    // The ordinary logger takes a mutex and prints to stdout. Neither is safe
    // if a crash interrupted logging, so keep a separate pre-opened handle.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        emergency_log("PANIC", format_args!("{info}"));
        previous_hook(info);
    }));

    #[cfg(windows)]
    windows::install();
}

fn write_record(writer: &mut impl Write, tag: &str, message: fmt::Arguments<'_>) {
    let _ = writeln!(
        writer,
        "[ERROR] [{tag}] version={} pid={} {message}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
    );
}

fn emergency_log(tag: &str, message: fmt::Arguments<'_>) {
    if let Some(file) = CRASH_LOG.get() {
        write_record(&mut &*file, tag, message);
        let _ = file.sync_all();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetUnhandledExceptionFilter, EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS,
        LPTOP_LEVEL_EXCEPTION_FILTER,
    };
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;

    static PREVIOUS_FILTER: OnceLock<LPTOP_LEVEL_EXCEPTION_FILTER> = OnceLock::new();

    pub(super) fn install() {
        let previous = unsafe { SetUnhandledExceptionFilter(Some(log_exception)) };
        let _ = PREVIOUS_FILTER.set(previous);
    }

    unsafe extern "system" fn log_exception(exception: *const EXCEPTION_POINTERS) -> i32 {
        if let Some(record) = exception
            .as_ref()
            .and_then(|info| info.ExceptionRecord.as_ref())
        {
            emergency_log(
                "WINDOWS_CRASH",
                format_args!(
                    "thread_id={} exception_code=0x{:08X} address={:p}",
                    GetCurrentThreadId(),
                    record.ExceptionCode as u32,
                    record.ExceptionAddress,
                ),
            );
        }

        // Preserve Windows crash reporting and any previously installed filter.
        // An access violation cannot be recovered with Rust catch_unwind.
        match PREVIOUS_FILTER.get().copied().flatten() {
            Some(previous) => previous(exception),
            None => EXCEPTION_CONTINUE_SEARCH,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_record_identifies_build_and_process() {
        let mut output = Vec::new();
        write_record(
            &mut output,
            "WINDOWS_CRASH",
            format_args!("exception_code=0xC0000005"),
        );
        let text = String::from_utf8(output).expect("UTF-8 crash record");

        assert!(text.contains("[WINDOWS_CRASH]"));
        assert!(text.contains(&format!("version={}", env!("CARGO_PKG_VERSION"))));
        assert!(text.contains(&format!("pid={}", std::process::id())));
        assert!(text.ends_with("exception_code=0xC0000005\n"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_exception_is_logged_in_isolated_process() {
        let path =
            std::env::temp_dir().join(format!("talkis-crash-probe-{}.log", std::process::id()));
        let _ = fs::remove_file(&path);
        let output = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "crash_diagnostics::tests::windows_exception_probe_child",
                "--ignored",
                "--test-threads=1",
            ])
            .env("TALKIS_CRASH_PROBE_LOG", &path)
            .output()
            .expect("isolated exception probe");
        let record = fs::read_to_string(&path).expect("persisted Windows exception");
        let _ = fs::remove_file(&path);

        assert_eq!(
            output.status.code().map(|code| code as u32),
            Some(0xE0424242)
        );
        assert!(record.contains("[WINDOWS_CRASH]"));
        assert!(record.contains("exception_code=0xE0424242"));
        assert!(record.contains("thread_id="));
        assert!(record.contains("address="));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Only run by the parent test in a disposable process"]
    fn windows_exception_probe_child() {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            RaiseException, SetErrorMode, SEM_NOGPFAULTERRORBOX,
        };

        let path = std::env::var_os("TALKIS_CRASH_PROBE_LOG").expect("isolated crash log path");
        install(Path::new(&path));
        unsafe {
            SetErrorMode(SEM_NOGPFAULTERRORBOX);
            RaiseException(0xE0424242, 0, 0, std::ptr::null());
        }
        panic!("exception unexpectedly continued");
    }
}
