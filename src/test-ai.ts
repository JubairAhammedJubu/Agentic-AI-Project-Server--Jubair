import dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY!;
console.log("GEMINI_API_KEY from env:", apiKey);

async function main() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;
    console.log("Requesting:", url);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Hello, reply with 'test success'" }] }]
      })
    });
    
    console.log("Response status:", res.status);
    const data = await res.json();
    console.log("Response JSON:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error occurred:", error);
  }
}
main();
