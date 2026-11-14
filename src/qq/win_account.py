"""Resolve the active QQ account using Windows ownership of its message database."""
import configparser
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import re

from win_process import api, boolean, check, close, dword, handle


class UniqueProcess(c.Structure):
    _fields_ = [("pid", dword), ("started", w.FILETIME)]


class ProcessInfo(c.Structure):
    _fields_ = [
        ("process", UniqueProcess), ("app", w.WCHAR * 256), ("service", w.WCHAR * 64),
        ("kind", dword), ("status", dword), ("session", dword), ("restartable", boolean),
    ]


rm = c.WinDLL("rstrtmgr")
rm.RmStartSession.argtypes = [c.POINTER(dword), dword, w.LPWSTR]
rm.RmRegisterResources.argtypes = [
    dword, w.UINT, c.POINTER(w.LPCWSTR), w.UINT, c.POINTER(UniqueProcess),
    w.UINT, c.POINTER(w.LPCWSTR),
]
rm.RmGetList.argtypes = [
    dword, c.POINTER(w.UINT), c.POINTER(w.UINT), c.POINTER(ProcessInfo), c.POINTER(dword),
]
rm.RmEndSession.argtypes = [dword]
for name in ("RmStartSession", "RmRegisterResources", "RmGetList", "RmEndSession"):
    getattr(rm, name).restype = dword

open_process = api("OpenProcess", handle, dword, boolean, dword)
get_process_times = api("GetProcessTimes", boolean, handle, *([c.POINTER(w.FILETIME)] * 4))


def filetime(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime


def process_start_time(pid):
    process = check(open_process(0x1000, False, pid))
    try:
        times = [w.FILETIME() for _ in range(4)]
        check(get_process_times(process, *(c.byref(value) for value in times)))
        return filetime(times[0])
    finally:
        close(process)


def rm_check(result):
    if result:
        raise c.WinError(result)


def owners(path):
    session = dword()
    rm_check(rm.RmStartSession(c.byref(session), 0, c.create_unicode_buffer(33)))
    try:
        rm_check(rm.RmRegisterResources(session, 1, (w.LPCWSTR * 1)(str(path)), 0, None, 0, None))
        needed = w.UINT()
        reasons = dword()
        processes = None
        for _ in range(4):
            count = w.UINT(len(processes) if processes is not None else 0)
            result = rm.RmGetList(session, c.byref(needed), c.byref(count), processes, c.byref(reasons))
            if result != 234:  # ERROR_MORE_DATA
                rm_check(result)
                return {
                    (item.process.pid, filetime(item.process.started))
                    for item in (processes or ())[:count.value]
                }
            processes = (ProcessInfo * needed.value)()
        raise RuntimeError("QQ database ownership changed during inspection")
    finally:
        rm.RmEndSession(session)


def data_root():
    public = Path(os.environ.get("PUBLIC", r"C:\Users\Public"))
    ini = public / "Documents" / "Tencent" / "QQ" / "UserDataInfo.ini"
    if ini.is_file():
        raw = ini.read_bytes()
        settings = configparser.ConfigParser(interpolation=None)
        settings.read_string(raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"))
        configured = settings.get("UserDataSet", "UserDataSavePath", fallback="").strip('" ')
        if configured and Path(configured).is_absolute():
            return Path(configured)
    return Path.home() / "Documents" / "Tencent Files"


class AccountDetector:
    def __init__(self, pid, root=None):
        self.owner = (pid, process_start_time(pid))
        self.root = root if root is not None else data_root()

    def current(self):
        if not self.root.is_dir():
            return None
        accounts = []
        for folder in self.root.iterdir():
            if not re.fullmatch(r"[1-9][0-9]{4,11}", folder.name):
                continue
            database = folder / "nt_qq" / "nt_db" / "nt_msg.db"
            if database.is_file() and self.owner in owners(database):
                accounts.append(folder.name)
        return accounts[0] if len(accounts) == 1 else None
