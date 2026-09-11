import pymongo
from app.config import settings
from app.auth import hash_password
from app.models import utc_now


def run_seed():
    client = pymongo.MongoClient(settings.mongodb_url)
    db = client[settings.mongodb_db_name]

    # Create indexes
    db.users.create_index("email", unique=True)
    db.subjects.create_index("name", unique=True)

    # Seed or update Admin User
    admin_doc = db.users.find_one({"email": settings.admin_email.lower()})
    admin_pwd_hash = hash_password(settings.admin_password)
    if not admin_doc:
        db.users.insert_one(
            {
                "name": "Administrator",
                "email": settings.admin_email.lower(),
                "password": admin_pwd_hash,
                "password_hash": admin_pwd_hash,
                "role": "admin",
                "isAccountVerified": True,
                "verifyOtp": "",
                "verifyOtpExpireAt": 0,
                "resetOtp": "",
                "resetOtpExpireAt": 0,
                "refreshToken": "",
                "refreshTokenExpireAt": 0,
                "active": True,
                "created_at": utc_now(),
            }
        )
    else:
        db.users.update_one(
            {"_id": admin_doc["_id"]},
            {"$set": {"password": admin_pwd_hash, "password_hash": admin_pwd_hash, "role": "admin", "isAccountVerified": True}},
        )


    # Seed Student User
    if not db.users.find_one({"email": settings.student_email}):
        db.users.insert_one(
            {
                "name": "Demo Student",
                "email": settings.student_email,
                "password_hash": hash_password(settings.student_password),
                "role": "student",
                "isAccountVerified": True,
                "verifyOtp": "",
                "verifyOtpExpireAt": 0,
                "resetOtp": "",
                "resetOtpExpireAt": 0,
                "refreshToken": "",
                "refreshTokenExpireAt": 0,
                "active": True,
                "created_at": utc_now(),
            }
        )

    # Seed Demo Exams
    if db.exams.count_documents({}) == 0:
        db.exams.insert_many([
            {
                "title": "Demo Mathematics Exam",
                "duration_minutes": 30,
                "max_violations": 2,
                "total_marks": 3,
                "active": True,
                "require_camera": True,
                "require_microphone": True,
                "created_at": utc_now(),
                "questions": [
                    {
                        "id": "1",
                        "type": "mcq",
                        "text": "What is 2 + 2?",
                        "options": ["3", "4", "5", "6"],
                        "correct_answer": 1,
                        "marks": 1,
                    },
                    {
                        "id": "2",
                        "type": "mcq",
                        "text": "What is 3 × 3?",
                        "options": ["6", "8", "9", "12"],
                        "correct_answer": 2,
                        "marks": 1,
                    },
                    {
                        "id": "3",
                        "type": "mcq",
                        "text": "Which is a prime number?",
                        "options": ["4", "6", "7", "9"],
                        "correct_answer": 2,
                        "marks": 1,
                    },
                ],
            },
            {
                "title": "Python Programming & Data Types Exam",
                "duration_minutes": 45,
                "max_violations": 3,
                "total_marks": 15,
                "active": True,
                "require_camera": True,
                "require_microphone": True,
                "created_at": utc_now(),
                "questions": [
                    {
                        "id": "1",
                        "type": "mcq",
                        "text": "What is the return type of the built-in input() function in Python 3?",
                        "options": ["int", "str", "float", "object"],
                        "correct_answer": 1,
                        "marks": 2,
                    },
                    {
                        "id": "2",
                        "type": "code",
                        "language": "python",
                        "text": "Write a Python programming language code to take two numbers from the user and find their sum using Typecasting.",
                        "starter_code": "# Write your Python code below\n# Take two inputs, typecast them to int or float, and print their sum\n",
                        "sample_solution": "num1 = float(input(\"Enter first number: \"))\nnum2 = float(input(\"Enter second number: \"))\nsum_result = num1 + num2\nprint(\"Sum:\", sum_result)",
                        "marks": 8,
                    },
                    {
                        "id": "3",
                        "type": "code",
                        "language": "python",
                        "text": "Write a function `is_even(n)` that returns True if a number is even, and False otherwise.",
                        "starter_code": "def is_even(n: int) -> bool:\n    # Write your solution here\n    pass\n",
                        "sample_solution": "def is_even(n: int) -> bool:\n    return n % 2 == 0",
                        "marks": 5,
                    },
                ],
            }
        ])

    print("Seed complete")


if __name__ == "__main__":
    run_seed()
