import vue from "@vitejs/plugin-vue";

export default {
  plugins: [vue()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  }
};
