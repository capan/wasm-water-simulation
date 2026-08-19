const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require("path");

module.exports = {
  experiments: {
    asyncWebAssembly: true,
  },
  entry: "./bootstrap.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bootstrap.js",
  },
  // Development by default so `npm start` keeps readable stack traces. The
  // Dockerfile sets NODE_ENV=production, which is what the deployed bundle gets.
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
  devServer: {
    static: [{ directory: path.resolve(__dirname, "dist") }],
  },
  plugins: [
    new CopyWebpackPlugin([
      { from: "index.html", to: "index.html" },
      // these pages load the modules natively, no bundling involved
      { from: "diagnose.html", to: "diagnose.html" },
      { from: "soilcheck.html", to: "soilcheck.html" },
      { from: "elevation.mjs", to: "elevation.mjs" },
      { from: "tiles.mjs", to: "tiles.mjs" },
      { from: "soil.mjs", to: "soil.mjs" },
    ]),
  ],
  module: {
    rules: [
      {
        test: /\.wasm$/,
        type: "webassembly/async",
      },
    ],
  },
};
