#!/usr/bin/env python3
"""Build an importable ZIP for an existing Streamable HTTP MCP server."""

import argparse
import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


def https_server_url(value: str) -> str:
    url = value.strip()
    try:
        address = urlsplit(url)
        host = address.hostname or ""
        _ = address.port
    except ValueError as error:
        raise argparse.ArgumentTypeError("Invalid MCP server URL") from error
    if (
        address.scheme != "https"
        or "." not in host
        or address.username is not None
        or address.password is not None
        or address.fragment
        or any(character.isspace() for character in url)
    ):
        raise argparse.ArgumentTypeError("Use an HTTPS server URL with a hostname and no embedded credentials")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return url
    raise argparse.ArgumentTypeError("Use a DNS hostname rather than a literal IP address")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Plugin name")
    parser.add_argument("--description", default="", help="What the plugin does")
    parser.add_argument("--url", type=https_server_url, required=True, help="MCP server URL")
    parser.add_argument("--output", type=Path, required=True, help="Destination ZIP file")
    args = parser.parse_args()

    name = args.name.strip()
    if not name:
        parser.error("Plugin name must not be blank")
    if args.output.suffix.lower() != ".zip":
        parser.error("The output filename must end in .zip")

    manifest = json.dumps(
        {"name": name, "description": args.description.strip(), "url": args.url},
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    if len(manifest) > 256 * 1024:
        parser.error("The plugin manifest must be at most 256 KB")

    try:
        with ZipFile(args.output, "x", compression=ZIP_DEFLATED) as package:
            package.writestr("manifest.json", manifest)
    except OSError as error:
        parser.error(str(error))
    print(args.output)


if __name__ == "__main__":
    main()
