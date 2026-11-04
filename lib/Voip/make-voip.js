export const makeVoip = async (sock, opts) => {
    const { default: Voip } = await import('./index.js');
    return new Voip(sock, opts);
};
export default makeVoip;
