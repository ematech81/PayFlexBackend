
module.exports = function errorHandler(err, req, res, next) {
  let error = err;

  // Handle case where err is undefined or null
  if (!error) {
    error = new Error("Unknown error");
  }

  // Convert non-Error objects to Error
  if (!(error instanceof Error)) {
    error = new Error(String(error));
  }

  // Default status and message
  const status = error.statusCode || error.status || 500;
  const message = error.message || "Internal Server Error";

  console.error("Error:", error);

  res.status(status).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== "production" && { stack: error.stack }),
  });
};