#!/usr/bin/env python3
"""Create Massivlust Prosjekter Shared Drive with folder structure and permissions."""
import json
import sys
import uuid
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

KEY_PATH = Path("/Users/max/cortextos/orgs/westside-hq/secrets/wda-fleet-agent-key.json")
SCOPES = ["https://www.googleapis.com/auth/drive"]
ADMIN_EMAIL = "alex@massivlust.no"

WRITERS = [
    "alex@massivlust.no",
    "martin@massivlust.no",
    "vegard@massivlust.no",
    "eivind@massivlust.no",
]

READERS = [
    "sondre@massivlust.no",
    "mathias@massivlust.no",
]

PROJECTS = [
    "Verksgata 54",
    "Breivikveien 14",
    "Roan",
    "Ullsåk",
    "Bortelid sentrumsbygg",
]

PROJECT_SUBFOLDERS = [
    "00 Oversikt",
    "01 Avvik",
    "02 Bilder",
    "03 Mail",
    "04 Dokumenter",
    "05 Sjekklister",
    "06 HMS",
]

TOP_LEVEL_FOLDERS = [
    "Maler og rutiner",
    "Kompetanse",
]


def get_service():
    creds = service_account.Credentials.from_service_account_file(
        str(KEY_PATH), scopes=SCOPES
    ).with_subject(ADMIN_EMAIL)
    return build("drive", "v3", credentials=creds)


def create_shared_drive(svc):
    request_id = str(uuid.uuid4())
    body = {"name": "Massivlust Prosjekter"}
    result = svc.drives().create(requestId=request_id, body=body).execute()
    drive_id = result["id"]
    print(f"Shared Drive opprettet: {result['name']} (id: {drive_id})")
    return drive_id


def create_folder(svc, name, parent_id, drive_id):
    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }
    result = svc.files().create(
        body=metadata,
        fields="id,name",
        supportsAllDrives=True,
    ).execute()
    print(f"  Mappe: {name} ({result['id']})")
    return result["id"]


def add_permission(svc, drive_id, email, role):
    body = {
        "type": "user",
        "role": role,
        "emailAddress": email,
    }
    try:
        svc.permissions().create(
            fileId=drive_id,
            body=body,
            supportsAllDrives=True,
            sendNotificationEmail=False,
        ).execute()
        print(f"  Tilgang: {email} = {role}")
    except Exception as e:
        print(f"  Tilgang FEILET for {email}: {e}", file=sys.stderr)


def main():
    svc = get_service()

    print("=== Oppretter Shared Drive ===")
    drive_id = create_shared_drive(svc)

    print("\n=== Setter opp tilganger ===")
    for email in WRITERS:
        if email == ADMIN_EMAIL:
            continue
        add_permission(svc, drive_id, email, "writer")

    for email in READERS:
        add_permission(svc, drive_id, email, "reader")

    print("\n=== Oppretter mappestruktur ===")
    folder_map = {"_drive_id": drive_id}

    for project in PROJECTS:
        print(f"\nProsjekt: {project}")
        project_id = create_folder(svc, project, drive_id, drive_id)
        folder_map[project] = {"_id": project_id}
        for subfolder in PROJECT_SUBFOLDERS:
            sub_id = create_folder(svc, subfolder, project_id, drive_id)
            folder_map[project][subfolder] = sub_id

    print("\n--- Fellesressurser ---")
    for folder in TOP_LEVEL_FOLDERS:
        folder_id = create_folder(svc, folder, drive_id, drive_id)
        folder_map[folder] = folder_id

    output_path = Path(__file__).parent / "shared_drive_map.json"
    with open(output_path, "w") as f:
        json.dump(folder_map, f, indent=2, ensure_ascii=False)
    print(f"\nMappe-IDs lagret til: {output_path}")

    print(f"\nShared Drive link: https://drive.google.com/drive/folders/{drive_id}")
    print("FERDIG!")


if __name__ == "__main__":
    main()
