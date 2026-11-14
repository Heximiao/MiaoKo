"""Windows process and module discovery for the QQ adapter."""
import ctypes as c
from ctypes import wintypes as w
import os

kernel = c.WinDLL("kernel32", use_last_error=True)


def api(name, result, *arguments):
    fn = getattr(kernel, name)
    fn.restype, fn.argtypes = result, arguments
    return fn


def check(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result


handle = w.HANDLE
pointer = c.c_void_p
size = c.c_size_t
dword = w.DWORD
boolean = w.BOOL
close = api("CloseHandle", boolean, handle)
snapshot = api("CreateToolhelp32Snapshot", handle, dword, dword)


class ProcessEntry(c.Structure):
    _fields_ = [
        ("size", dword), ("usage", dword), ("pid", dword), ("heap", size),
        ("module", dword), ("threads", dword), ("parent", dword),
        ("priority", w.LONG), ("flags", dword), ("exe", w.WCHAR * 260),
    ]


class ModuleEntry(c.Structure):
    _fields_ = [
        ("size", dword), ("moduleId", dword), ("pid", dword), ("globalUsage", dword),
        ("processUsage", dword), ("base", pointer), ("length", dword),
        ("moduleHandle", handle), ("name", w.WCHAR * 256), ("path", w.WCHAR * 260),
    ]


first_process = api("Process32FirstW", boolean, handle, c.POINTER(ProcessEntry))
next_process = api("Process32NextW", boolean, handle, c.POINTER(ProcessEntry))
first_module = api("Module32FirstW", boolean, handle, c.POINTER(ModuleEntry))
next_module = api("Module32NextW", boolean, handle, c.POINTER(ModuleEntry))

def list_entries(flags, pid, entry_type, first, next_entry):
    listing = snapshot(flags, pid)
    if listing == pointer(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        item = entry_type()
        item.size = c.sizeof(item)
        ok = first(listing, c.byref(item))
        while ok:
            yield entry_type.from_buffer_copy(item)
            ok = next_entry(listing, c.byref(item))
    finally:
        close(listing)


def find_qq(root=None, pid=None):
    exe = os.path.normcase(str(root / "QQ.exe")) if root is not None else None
    matches = []
    for process in list_entries(2, 0, ProcessEntry, first_process, next_process):
        if process.exe.casefold() != "qq.exe" or (pid is not None and process.pid != pid):
            continue
        try:
            modules = list(list_entries(8, process.pid, ModuleEntry, first_module, next_module))
        except OSError:
            continue
        executable = next((item.path for item in modules if item.name.casefold() == "qq.exe"), None)
        if executable is None or (exe is not None and os.path.normcase(executable) != exe):
            continue
        wrappers = [item for item in modules if item.name.casefold() == "wrapper.node"]
        for module in wrappers:
            matches.append((process.pid, executable, module.path, module.base))
    return matches


def locate_qq(root=None, pid=None):
    matches = find_qq(root, pid)
    if not matches:
        raise RuntimeError("No accessible QQ process with a loaded wrapper.node. Open QQ in your Windows session.")
    if len(matches) > 1:
        candidates = ", ".join(f"PID {pid} ({exe})" for pid, exe, _, _ in matches)
        raise RuntimeError(f"Multiple QQ processes found: {candidates}. Select one with --pid.")
    return matches[0]


