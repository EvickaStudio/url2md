export class Limit {
  constructor(max = 4) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        this.active++;
        try {
          const res = await fn();
          resolve(res);
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
          this._next();
        }
      };
      this.queue.push(task);
      this._next();
    });
  }

  _next() {
    if (this.active >= this.max) return;
    const task = this.queue.shift();
    if (task) task();
  }
}

