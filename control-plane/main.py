from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import httpx
import hashlib
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class InferRequest(BaseModel):
    prompt: str

def generate_ai_image(prompt: str) -> str:
    """Generate AI image using FREE Pollinations API with fallback"""
    try:
        # Clean prompt for URL
        prompt_clean = prompt.replace(" ", "%20").replace('"', '').replace("'", "")
        image_url = f"https://image.pollinations.ai/prompt/{prompt_clean}?width=512&height=512"
        return image_url
    except:
        # Fallback to deterministic picsum based on prompt
        prompt_hash = hashlib.md5(prompt.encode()).hexdigest()
        return f"https://picsum.photos/seed/{prompt_hash}/512/512"

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "ai-worker"}

@app.post("/infer")
async def infer_endpoint(req: InferRequest):
    """Generate AI image from prompt"""
    try:
        image_url = generate_ai_image(req.prompt)
        
        return {
            "prompt": req.prompt,
            "image_url": image_url,
            "model": "pollinations-ai",
            "success": True
        }
        
    except Exception as e:
        # Ultimate fallback
        prompt_hash = hashlib.md5(req.prompt.encode()).hexdigest()
        return {
            "prompt": req.prompt,
            "image_url": f"https://picsum.photos/seed/{prompt_hash}/512/512",
            "model": "fallback",
            "success": False,
            "error": str(e)
        }