# Fidelity [![CI](https://github.com/daggerok/fidelity-portfolio/actions/workflows/ci.yaml/badge.svg)](https://github.com/daggerok/fidelity-portfolio/actions/workflows/ci.yaml) [![GitHub Pages](https://github.com/daggerok/fidelity-portfolio/actions/workflows/github-pages.yml/badge.svg)](https://github.com/daggerok/fidelity-portfolio/actions/workflows/github-pages.yml)

[Fidelity investments analyzer](https://daggerok.github.io/fidelity-portfolio/)

Bun build requirements:

```bash
nvm install --lts
nvm alias default 'lts/*'

echo '
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
' >> ~/.zshrc
source ~/.zshrc
```

<!--

```markdown
here is my setup

package.json
```json
{
  "name": "fidelity",
  "version": "1.0.0",
  "description": "Math for Ameliia",
  "source": "src/index.html",
  "scripts": {
    "clean": "rimraf -rf dist",
    "prebuild": "npm run clean",
    "build-github-pages": "npm run build -- --public-url=/fidelity/",
    "serve": "parcel --no-cache --no-source-maps",
    "build": "parcel build --no-cache --no-source-maps",
    "start": "pm2 start 'npm run serve' --name app",
    "restart": "pm2 restart app",
    "stop": "pm2 kill",
    "logs": "pm2 logs",
    "test": "jest src",
    "dev": "npm run test -- --watchAll"
  },
  "keywords": [
    "parcel",
    "rimraf",
    "sass",
    "jest",
    "pm2"
  ],
  "author": "Maksim Kostromin / GitHub: daggerok",
  "license": "MIT",
  "dependencies": {
    "clsx": "2.1.1",
    "lucide-react": "1.16.0",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "recharts": "3.8.1",
    "tailwind-merge": "3.6.0"
  },
  "devDependencies": {
    "@parcel/transformer-sass": "2.16.4",
    "@tailwindcss/postcss": "4.3.0",
    "@types/node": "25.6.0",
    "@types/papaparse": "5.5.2",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "jest": "30.3.0",
    "papaparse": "5.5.3",
    "parcel": "2.16.4",
    "pm2": "6.0.14",
    "rimraf": "6.1.3",
    "sass": "1.99.0",
    "tailwindcss": "4.3.0"
  },
  "postcss": {
    "plugins": {
      "@tailwindcss/postcss": {}
    }
  }
}
```
src/index.html
```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fidelity Portfolio Analyzer - Event Sourcing Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="icon" type="image/png" href="./favicon.png">
    <link href="./index.css" type="text/css" rel="stylesheet" />
</head>
<body>
<div id="root"/>
<script src="./main.tsx" type="module"></script>
</body>
</html>
```
index.css
```css
@import "tailwindcss";
```
src/favicon.png and src/main.tsx:
```tsx
...
```
NOTE: implement all needed code in main.tsx so it will be easier to communicate...

...
```

-->
