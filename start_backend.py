import uvicorn
from backend.main import app
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("Starting ComfyUI Workflow Agent Backend Server")
    logger.info("=" * 60)
    logger.info(f"API Version: {app.version}")
    logger.info(f"API Title: {app.title}")
    logger.info(f"API Description: {app.description}")
    logger.info("=" * 60)
    logger.info("Server will be available at:")
    logger.info("  - Main API: http://localhost:8000")
    logger.info("  - Health Check: http://localhost:8000/health")
    logger.info("  - API Docs: http://localhost:8000/docs")
    logger.info("  - ReDoc: http://localhost:8000/redoc")
    logger.info("=" * 60)
    logger.info("Press Ctrl+C to stop the server")
    logger.info("=" * 60)
    
    try:
        uvicorn.run(
            "backend.main:app",
            host="0.0.0.0",
            port=8000,
            reload=True,
            log_level="info"
        )
    except KeyboardInterrupt:
        logger.info("\n" + "=" * 60)
        logger.info("Server stopped by user")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"Error starting server: {e}")
        raise
