/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          750: '#1f2937',
          850: '#0f172a',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
