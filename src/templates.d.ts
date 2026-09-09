declare module '*.mustache' {
  const template: string;
  export default template;
}

declare module '*.md' {
  const value: string;
  export default value;
}
