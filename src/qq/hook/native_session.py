"""Load and control a build-matched QQ hook module on Windows x64."""
import ctypes as c
import os
from pathlib import Path

from win_process import (
    ModuleEntry, api, boolean, check, close, dword, first_module, handle, list_entries,
    next_module, pointer, size,
)

open_process = api("OpenProcess", handle, dword, boolean, dword)
alloc = api("VirtualAllocEx", pointer, handle, pointer, size, dword, dword)
free = api("VirtualFreeEx", boolean, handle, pointer, size, dword)
write = api("WriteProcessMemory", boolean, handle, pointer, pointer, size, c.POINTER(size))
thread = api("CreateRemoteThread", handle, handle, pointer, size, pointer, pointer, dword, pointer)
wait = api("WaitForSingleObject", dword, handle, dword)
exit_code = api("GetExitCodeThread", boolean, handle, c.POINTER(dword))
load_local = api("LoadLibraryExW", handle, c.c_wchar_p, handle, dword)
unload_local = api("FreeLibrary", boolean, handle)
proc = api("GetProcAddress", pointer, handle, c.c_char_p)
module_handle = api("GetModuleHandleW", handle, c.c_wchar_p)
module_from_address = api("GetModuleHandleExW", boolean, dword, pointer, c.POINTER(handle))
module_path = api("GetModuleFileNameW", dword, handle, c.c_wchar_p, dword)


class AttachConfig(c.Structure):
    _fields_ = [
        ("call_rva", c.c_uint32),
        ("instruction", c.c_ubyte * 6),
        ("pipe", c.c_wchar * 128),
    ]


class ActionConfig(c.Structure):
    _fields_ = AttachConfig._fields_ + [("request", c.c_char * 8192)]


def module_base(pid, path):
    expected = os.path.normcase(str(path))
    return next((item.base for item in list_entries(8, pid, ModuleEntry, first_module, next_module)
                 if os.path.normcase(item.path) == expected), None)


def call_remote(process, entry, data=None):
    allocation = None
    finished = True
    try:
        if data:
            allocation = check(alloc(process, None, len(data), 0x3000, 4))
            written = size()
            check(write(process, allocation, c.create_string_buffer(data), len(data), c.byref(written)))
            if written.value != len(data):
                raise RuntimeError("Incomplete remote parameter write")
        operation = check(thread(process, None, 0, entry, allocation, 0, None))
        finished = False
        try:
            if wait(operation, 10_000) != 0:
                raise RuntimeError("QQ did not finish the native operation within 10 seconds")
            finished = True
            code = dword()
            check(exit_code(operation, c.byref(code)))
            return code.value
        finally:
            close(operation)
    finally:
        if allocation and finished:
            check(free(process, allocation, 0, 0x8000))


def load_library_entry(pid):
    loader = check(proc(check(module_handle("kernel32.dll")), b"LoadLibraryW"))
    owner = handle()
    check(module_from_address(6, loader, c.byref(owner)))
    path = c.create_unicode_buffer(32768)
    check(module_path(owner, path, len(path)))
    remote = module_base(pid, path.value)
    if not remote:
        raise RuntimeError("Windows loader module differs in the target process")
    return remote + loader - owner.value


def control_addresses(pid, process, dll, names):
    base = module_base(pid, dll)
    if not base:
        call_remote(process, load_library_entry(pid), (str(dll) + "\0").encode("utf-16-le"))
        base = module_base(pid, dll)
        if not base:
            raise RuntimeError("QQ did not load the MiaoKo module")
    local = check(load_local(str(dll), None, 1))
    try:
        return tuple(base + check(proc(local, name)) - local for name in names)
    finally:
        check(unload_local(local))


class NativeSession:
    def __init__(self, pid, dll, rva, instruction, pipe, *, action_request=None, duplex=False):
        if len(instruction) != 6 or not 0 < len(pipe) < 128:
            raise ValueError("Invalid receive profile or pipe name")
        self.pid = pid
        self.dll = Path(dll).resolve(strict=True)
        config_fields = (rva, (c.c_ubyte * 6)(*instruction), pipe)
        if action_request is None:
            self.config = AttachConfig(*config_fields)
        else:
            if len(action_request) >= 8192 or b"\0" in action_request:
                raise ValueError("Invalid native action request")
            self.config = ActionConfig(*config_fields, action_request)
        self.process = None
        self.stop = None
        self.submit = None
        self.duplex = duplex

    def __enter__(self):
        self.process = check(open_process(0x0010043A, False, self.pid))
        try:
            names = (b"MiaoKoStart", b"MiaoKoStop")
            if self.duplex:
                names += (b"MiaoKoSubmit",)
            start, self.stop, *actions = control_addresses(self.pid, self.process, self.dll, names)
            self.submit = actions[0] if actions else None
            result = call_remote(self.process, start, bytes(self.config))
            if result == 10:
                raise RuntimeError("This QQ process already has an active MiaoKo listener")
            if result:
                raise RuntimeError(f"Native receiver did not start (status {result})")
            return self
        except BaseException:
            close(self.process)
            raise

    def submit_action(self, request):
        if self.submit is None or not 0 < len(request) < 8192 or b"\0" in request:
            raise ValueError("Invalid native action request")
        return call_remote(self.process, self.submit, request + b"\0")

    def is_running(self):
        result = wait(self.process, 0)
        if result == 0:
            return False
        if result == 258:  # WAIT_TIMEOUT
            return True
        raise c.WinError(c.get_last_error())

    def __exit__(self, *_):
        try:
            if self.is_running():
                result = call_remote(self.process, self.stop)
                if result:
                    raise RuntimeError(f"Native receiver did not stop cleanly (status {result})")
        finally:
            close(self.process)
