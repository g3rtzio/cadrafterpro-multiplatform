import { TestBed } from '@angular/core/testing';
import { MarkupTools } from './markup-tools';

describe('MarkupTools', () => {
  let service: MarkupTools;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MarkupTools);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
