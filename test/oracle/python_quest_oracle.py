#!/usr/bin/env python3
"""Pure conformance oracle copied from the Python Quest project's behavior."""

import json
import sys
from datetime import datetime


SUPPORTED_TASKS = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY",
]
VIDEO_TASKS = {"WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"}


def kget(value, *keys):
    if value is None:
        return None
    for key in keys:
        if key in value:
            return value[key]
    return None


def get_task_config(quest):
    config = quest.get("config", {})
    for key in ("taskConfig", "task_config", "taskConfigV2", "task_config_v2"):
        value = config.get(key)
        if value:
            return value
    if "tasks" in config:
        return config
    return None


def get_quest_name(quest):
    messages = quest.get("config", {}).get("messages", {})
    name = kget(messages, "questName", "quest_name")
    if name:
        return name.strip()
    game = kget(messages, "gameTitle", "game_title")
    if game:
        return game.strip()
    return f"Quest#{quest.get('id', '?')}"


def get_expires_at(quest):
    return kget(quest.get("config", {}), "expiresAt", "expires_at")


def parse_datetime(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_expired(quest, now):
    task_config = get_task_config(quest)
    if not task_config or "tasks" not in task_config:
        return False
    if not any(task_config["tasks"].get(task) is not None for task in SUPPORTED_TASKS):
        return False
    expires = get_expires_at(quest)
    if not expires:
        return False
    try:
        return parse_datetime(expires) <= now
    except Exception:
        return False


def get_user_status(quest):
    status = kget(quest, "userStatus", "user_status")
    return status if isinstance(status, dict) else {}


def is_completable(quest, now):
    expires = get_expires_at(quest)
    if expires:
        try:
            if parse_datetime(expires) <= now:
                return False
        except Exception:
            pass
    task_config = get_task_config(quest)
    if not task_config:
        return False
    tasks = task_config.get("tasks", {})
    return any(tasks.get(task) is not None for task in SUPPORTED_TASKS)


def is_enrolled(quest):
    return bool(kget(get_user_status(quest), "enrolledAt", "enrolled_at"))


def is_completed(quest):
    return bool(kget(get_user_status(quest), "completedAt", "completed_at"))


def get_task_type(quest):
    task_config = get_task_config(quest)
    if not task_config:
        return None
    tasks = task_config.get("tasks", {})
    for task in SUPPORTED_TASKS:
        if tasks.get(task) is not None:
            return task
    return None


def get_seconds_needed(quest):
    task_config = get_task_config(quest)
    task_type = get_task_type(quest)
    if not task_config or not task_type:
        return 0
    task_data = task_config.get("tasks", {}).get(task_type)
    if isinstance(task_data, dict):
        for key in (
            "target", "duration", "seconds", "time", "durationSeconds",
            "duration_seconds", "totalSeconds", "total_seconds",
        ):
            if key in task_data and task_data[key]:
                return float(task_data[key])
    elif isinstance(task_data, (int, float)) and task_data:
        return float(task_data)
    return 0


def get_seconds_done(quest):
    task_type = get_task_type(quest)
    if not task_type:
        return 0
    progress = get_user_status(quest).get("progress", {})
    value = progress.get(task_type, {})
    if isinstance(value, dict):
        return float(value.get("value", 0))
    return 0


def snapshot(quest, now):
    return {
        "id": quest.get("id"),
        "name": get_quest_name(quest),
        "taskType": get_task_type(quest),
        "secondsNeeded": get_seconds_needed(quest),
        "secondsDone": get_seconds_done(quest),
        "enrolledAt": kget(get_user_status(quest), "enrolledAt", "enrolled_at"),
        "expiresAt": get_expires_at(quest),
        "enrolled": is_enrolled(quest),
        "completed": is_completed(quest),
        "completable": is_completable(quest, now),
        "expired": is_expired(quest, now),
    }


def evaluate(payload):
    now = parse_datetime(payload["now"])
    quests = payload.get("quests", [])
    completed_ids = set(payload.get("completedIds", []))
    completable = [quest for quest in quests if is_completable(quest, now)]
    actionable_raw = [
        quest for quest in quests
        if is_enrolled(quest)
        and not is_completed(quest)
        and is_completable(quest, now)
        and quest.get("id") not in completed_ids
    ]
    videos = [quest for quest in actionable_raw if get_task_type(quest) in VIDEO_TASKS]
    others = [quest for quest in actionable_raw if get_task_type(quest) not in VIDEO_TASKS]

    return {
        "cases": [snapshot(quest, now) for quest in quests],
        "plan": {
            "stats": {
                "total": len(quests),
                "enrolled": sum(1 for quest in quests if is_enrolled(quest)),
                "completed": sum(1 for quest in quests if is_completed(quest)),
                "completable": len(completable),
            },
            "questMap": [
                {
                    "id": quest.get("id"),
                    "name": get_quest_name(quest),
                    "status": "done" if is_completed(quest) or quest.get("id") in completed_ids else "waiting",
                    "secondsDone": get_seconds_done(quest),
                    "secondsNeeded": get_seconds_needed(quest),
                    "taskType": get_task_type(quest) or "",
                }
                for quest in completable
            ],
            "unacceptedIds": [
                quest.get("id") for quest in quests
                if not is_enrolled(quest) and not is_completed(quest) and is_completable(quest, now)
            ],
            "videoIds": [quest.get("id") for quest in videos],
            "otherIds": [quest.get("id") for quest in others],
            "actionableIds": [quest.get("id") for quest in videos + others],
            "allDone": bool(quests) and all(
                is_completed(quest) or not is_completable(quest, now) for quest in quests
            ),
        },
    }


if __name__ == "__main__":
    json.dump(evaluate(json.load(sys.stdin)), sys.stdout, ensure_ascii=False, sort_keys=True)
