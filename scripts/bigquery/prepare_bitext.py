"""
Turn the Bitext retail-banking customer-support dataset (Hugging Face:
bitext/Bitext-retail-banking-llm-chatbot-training-dataset, licence CDLA-Sharing-1.0) into
knowledge documents for Northstar Bank.

Usage: python3 prepare_bitext.py <bitext.csv> <export-dir>

- Keeps up to 3 answers per intent (the shortest complete ones), plus up to 8 example customer
  questions per intent, used for semantic matching.
- Fills the dataset's {{placeholders}} with neutral Northstar wording.
Writes kb_documents_bitext.json into <export-dir>.
"""
import csv
import json
import re
import sys
from collections import defaultdict

FILL = {
    "Bank Name": "Northstar Bank", "Banking App": "the Northstar app", "Bank App": "the Northstar app",
    "Company Website": "the Northstar website", "Company Website URL": "the Northstar website",
    "Customer Support": "Northstar customer support", "Customer Support Team": "our support team",
    "Customer Support Phone Number": "this support line", "Customer Support Working Hours": "our support hours",
    "Customer Service Working Hours": "our support hours", "Customer Support Email": "our support email",
    "Customer Support Email Address": "our support email", "Customer Service Email Address": "our support email",
    "Live Chat": "live chat in the app", "Full Name": "", "Name": "", "Credit Card": "card",
}
PH = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def fill(text: str) -> str:
    t = PH.sub(lambda m: FILL.get(m.group(1), m.group(1).lower()), text)
    t = re.sub(r"[ \t]+([,.!?])", r"\1", re.sub(r"[ \t]{2,}", " ", t))
    return t.strip()


def main(src: str, out: str) -> None:
    by_intent = defaultdict(list)
    with open(src, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            by_intent[(r["category"], r["intent"])].append(r)
    docs = []
    for (category, intent), rows in sorted(by_intent.items()):
        questions = list(dict.fromkeys(fill(r["instruction"]) for r in rows))[:8]
        answers = sorted({fill(r["response"]) for r in rows if len(r["response"]) > 80}, key=len)[:3]
        title = intent.replace("_", " ").replace("ATM", "ATM").capitalize()
        for i, a in enumerate(answers, 1):
            docs.append({
                "doc_id": f"FAQ-{intent}-{i}", "source": "bitext", "title": title, "content": a,
                "categories": [category.lower()], "keywords": [], "steps": [], "rule_refs": [], "intent": intent,
                "sample_questions": questions, "version": "bitext-retail-banking", "license": "CDLA-Sharing-1.0 (Bitext)",
            })
    with open(f"{out}/kb_documents_bitext.json", "w") as f:
        f.writelines(json.dumps(d) + "\n" for d in docs)
    print(f"bitext: {len(docs)} documents from {len(by_intent)} intents")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
