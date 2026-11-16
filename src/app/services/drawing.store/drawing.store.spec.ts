import { TestBed } from '@angular/core/testing';
import { DrawingStore } from './drawing.store';

describe('DrawingStore', () => {
  let service: DrawingStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DrawingStore);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
