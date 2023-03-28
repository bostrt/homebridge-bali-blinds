/* eslint-disable @typescript-eslint/no-explicit-any */
import https from 'https';

/**
* Promise-based https request
*/
export function htRequest(urlOptions: any, data = '', isJson = true): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(urlOptions,
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk.toString()));
        res.on('error', err => reject(err));
        res.on('end', () => {
          if (res.statusCode! < 200 || res.statusCode! > 299) {
            reject(new Error(`Request failed. ${res.statusCode}, body: ${body}`));
          }
          if (!isJson) {
            resolve(body);
            return;
          }
          try {
            const payload = JSON.parse(body);
            if (payload?.data?.error_text) {
              reject(new Error(`Request returned error_text: ${payload.data.error_text}`));
            }
            // resolve({statusCode: res.statusCode, headers: res.headers, body: payload});
            resolve(payload);
          } catch(err) {
            reject(new Error(`Failed to parse http body ${body} as json due to error: ${err}`));
          }
        });
      });
    req.on('error', error => reject(`HTTPS Request failed with error: ${error}`));
    req.write(data, 'binary');
    req.end();
  });
}