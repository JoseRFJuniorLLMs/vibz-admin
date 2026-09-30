"""Local password authentication for vibz-admin."""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError


HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)


@dataclass(frozen=True)
class Actor:
    id: int
    username: str
    role: str
    csrf_token: str
    session_hash: str


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 256:
        raise ValueError("A senha deve ter entre 12 e 256 caracteres")
    return HASHER.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return HASHER.verify(stored_hash, password)
    except (InvalidHashError, VerificationError):
        return False


def new_secret() -> str:
    return secrets.token_urlsafe(32)
