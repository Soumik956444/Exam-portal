import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from .config import settings

logger = logging.getLogger("email_service")


def _send_smtp(to_email: str, subject: str, body: str, html_body: str | None = None) -> bool:
    if not settings.smtp_host or not settings.smtp_user:
        logger.info(f"📧 [DEV EMAIL SIMULATOR] To: {to_email} | Subject: {subject}\nBody:\n{body}")
        print(f"\n==================== 📧 DEV EMAIL SIMULATOR ====================")
        print(f"To: {to_email}")
        print(f"Subject: {subject}")
        print(f"Body: {body}")
        print(f"===============================================================\n")
        return True

    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = settings.sender_email or settings.smtp_user
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain"))
        if html_body:
            msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_pass)
            server.sendmail(msg["From"], [to_email], msg.as_string())
        return True
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


async def send_email(to_email: str, subject: str, body: str, html_body: str | None = None) -> bool:
    return await asyncio.to_thread(_send_smtp, to_email, subject, body, html_body)


async def send_welcome_and_otp(name: str, email: str, otp: str):
    subject = "Welcome to Secure Exam Portal - Verify Your Email"
    body = (
        f"Hello {name},\n\n"
        f"Welcome to Secure Exam Portal! Your account has been registered with email: {email}.\n"
        f"Your verification OTP is: {otp}\n"
        f"This OTP is valid for 10 minutes.\n\n"
        f"If you did not register for this account, please ignore this email."
    )
    await send_email(email, subject, body)


async def send_verification_otp(name: str, email: str, otp: str):
    subject = "Account Verification OTP - Secure Exam Portal"
    body = (
        f"Hello {name},\n\n"
        f"Your OTP for verifying your account is: {otp}\n"
        f"This OTP is valid for 10 minutes.\n\n"
        f"If you did not request this OTP, please ignore this email."
    )
    await send_email(email, subject, body)


async def send_reset_password_otp(name: str, email: str, otp: str):
    subject = "Password Reset OTP - Secure Exam Portal"
    body = (
        f"Hello {name},\n\n"
        f"Your OTP for resetting your password is: {otp}\n"
        f"Use this OTP to proceed with resetting your password (valid for 15 minutes).\n\n"
        f"If you did not request a password reset, please secure your account immediately."
    )
    await send_email(email, subject, body)
