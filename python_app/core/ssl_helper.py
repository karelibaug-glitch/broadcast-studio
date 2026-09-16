"""
Zero-Configuration SSL Certificate Generator for Pro Broadcast Studio
Generates self-signed TLS certificates dynamically using cryptography.
Enables Secure Context (HTTPS) on LAN for mobile and remote browsers.
"""

import os
import socket
import datetime
from typing import Tuple, List

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
import ipaddress


def get_local_ip_addresses() -> List[str]:
    """Detects all LAN IPv4 addresses of the current machine."""
    ips = set(["127.0.0.1", "0.0.0.0"])
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            ips.add(ip)
    except Exception:
        pass

    # Socket probe method for default route
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    return list(ips)


def get_or_create_ssl_cert(ssl_dir: str = "ssl") -> Tuple[str, str]:
    """
    Returns paths to (cert_file, key_file).
    If they do not exist, automatically creates a new 2048-bit RSA self-signed
    certificate with Subject Alternative Names (SAN) for localhost and all local IPs.
    """
    os.makedirs(ssl_dir, exist_ok=True)
    cert_path = os.path.abspath(os.path.join(ssl_dir, "cert.pem"))
    key_path = os.path.abspath(os.path.join(ssl_dir, "key.pem"))

    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path

    print(f"[SSL Helper] Generating zero-config TLS/SSL certificate in '{ssl_dir}'...")

    # 1. Generate Private Key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    # 2. Build Subject and Issuer Names
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Pro Broadcast Studio"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])

    # 3. Add Subject Alternative Names for localhost and all detected LAN IPs
    alt_names = [
        x509.DNSName("localhost"),
        x509.DNSName("*.localhost"),
    ]

    for ip_str in get_local_ip_addresses():
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(ip_str)))
        except ValueError:
            pass

    # 4. Build Certificate (valid for 10 years)
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName(alt_names),
            critical=False,
        )
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None),
            critical=True,
        )
        .sign(private_key, hashes.SHA256())
    )

    # 5. Write Key File
    with open(key_path, "wb") as f:
        f.write(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    # 6. Write Certificate File
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print(f"[SSL Helper] Zero-config TLS/SSL certificate ready:\n  Cert: {cert_path}\n  Key:  {key_path}")
    return cert_path, key_path
